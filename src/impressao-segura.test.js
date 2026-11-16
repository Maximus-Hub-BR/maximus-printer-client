const {test}=require('node:test');
const assert=require('node:assert/strict');
const {criarFilaDeImpressao}=require('./fila-impressao');
const {obterConcessoes}=require('./concessao-de-impressao');
const {decidirSobreJob,aplicarDecisaoDoJob}=require('./decisao-do-job');
const item=id=>({job_uuid:id,type:'zpl',printer_system_name:'LABEL'});
test('falha após envio parcial não repete os itens do lote (regressão A,A,B)',async()=>{
 let liberar;const bloqueio=new Promise(r=>liberar=r);const envios=[],acks=[];
 const fila=criarFilaDeImpressao({imprimir:async lote=>{envios.push(lote.map(i=>i.job.job_uuid));if(lote[0].job.job_uuid==='inicial')await bloqueio;else throw Error('USB falhou após A');},confirmar:(i,s,e)=>acks.push({id:i.job.job_uuid,s,e})});
 const fim=fila.enfileirar(item('inicial'),11);fila.enfileirar(item('A'),11);fila.enfileirar(item('B'),11);liberar();await fim;
 assert.deepEqual(envios,[['inicial'],['A','B']]);assert.equal(acks.length,3);assert.match(acks[1].e,/RESULTADO_INCERTO/);assert.equal(fila.ocupada(),false);
});
test('900 pedidos continuam agrupados e ordenados, sem pausa por etiqueta',async()=>{
 let soltar;const primeiro=new Promise(r=>soltar=r);const envios=[],acks=[];
 const fila=criarFilaDeImpressao({imprimir:async l=>{envios.push(l.map(i=>i.job.job_uuid));if(envios.length===1)await primeiro;},confirmar:i=>acks.push(i.job.job_uuid)});
 const fim=fila.enfileirar(item('0'),11);for(let i=1;i<900;i++)fila.enfileirar(item(String(i)),11);soltar();await fim;
 assert.equal(envios.length,37);assert.equal(new Set(acks).size,900);assert.deepEqual(envios.flat(),Array.from({length:900},(_,i)=>String(i)));
});
test('concessão negada ou HTTP perdido não autoriza envio físico',async()=>{
 const lote=[{job:{...item('A'),controle:{versao:1}}}];let bytes=0;
 for(const reivindicar of [async()=>false,async()=>{throw Error('resposta perdida');}]){
  await assert.rejects(async()=>{await obterConcessoes(lote,reivindicar);bytes++;});
 }assert.equal(bytes,0);
});
test('reinício com job controlado em enviando gera ACK incerto e nenhuma impressão',()=>{
 const decisao=decidirSobreJob({estado:'enviando',podeReimprimir:true,controleSeguro:true});let bytes=0;const acks=[];
 aplicarDecisaoDoJob({job:item('A'),userId:11,decisao,registro:{marcarImpresso:(...a)=>acks.push(a),salvar(){}},imprimir:()=>bytes++,registrar(){},agendarAcks(){}});
 assert.equal(bytes,0);assert.equal(acks[0][1],'error');assert.match(acks[0][2],/RESULTADO_INCERTO/);
});

test('reinício publica ACK incerto sem depender de nova entrega e respeita usuário',()=>{
 const {criarRegistroDeImpressao}=require('./registro-de-impressao');let disco={};
 const portas={ler:()=>JSON.parse(JSON.stringify(disco)),gravar:d=>{disco=JSON.parse(JSON.stringify(d));}};
 const antes=criarRegistroDeImpressao(portas);antes.marcarEnviando('A',true,11);
 assert.deepEqual(antes.pendentesDeConfirmacao(11),[]);
 const depois=criarRegistroDeImpressao(portas);
 assert.equal(depois.pendentesDeConfirmacao(11).length,1);assert.equal(depois.pendentesDeConfirmacao(11)[0].status,'error');
 assert.match(depois.pendentesDeConfirmacao(11)[0].error,/RESULTADO_INCERTO/);assert.deepEqual(depois.pendentesDeConfirmacao(12),[]);
 assert.equal(depois.podeReimprimir('A'),false);
});

test('o desmentido pós-ACK observa só job CONTROLADO com sucesso, decide no backend e não toca o diário',()=>{
 const fs=require('fs'),path=require('path');
 const main=fs.readFileSync(path.join(__dirname,'..','main.js'),'utf8');
 // 1. O gancho existe no desfecho e é condicionado a sucesso + controle v1.
 const gancho=main.indexOf("status === 'success' && item.job.controle?.versao === 1");
 assert.ok(gancho>0,'o observador perdeu a condição de sucesso + controle');
 assert.ok(/observadorPosAck\.observar\(/.test(main),'o confirmar não agenda a observação');
 // 2. O desmentido publica com o prefixo que o backend reconhece — e é o
 //    BACKEND quem desfaz; o cliente não mexe em marcação nenhuma.
 assert.ok(main.includes('DESMENTIDO: ${motivo}'),'o prefixo DESMENTIDO sumiu do desmentido');
 // 3. O caminho do desmentido NUNCA escreve no diário: o registro de envio é
 //    o que impede o pull de reimprimir, e desmentir a marcação não é
 //    esquecer o envio.
 const inicio=main.indexOf('function publicarDesmentido');
 const corpo=main.slice(inicio,main.indexOf('const observadorPosAck'));
 assert.ok(inicio>0&&corpo.length>0,'publicarDesmentido sumiu do main');
 assert.ok(!corpo.includes('registroDeImpressao.'),'o desmentido passou a tocar o diário — o pull pode reimprimir');
 // 4. Falha aberta por desenho: ZPL direto por TCP não tem leitura de fila.
 assert.ok(/zplDireto\)\s*return \{ evidencia: null \}/.test(main),'o TCP direto deixou de ser "não sei"');
});
