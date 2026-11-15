/** Identidade que o backend USB do CUPS descobriu agora, vinculada à URI da fila.
 * Não usa o nome livre da impressora como prova de linguagem. */
function observacoesCups(filas, descoberta, agora = new Date().toISOString()) {
 const dispositivos=new Map();let atual=null;
 for(const linha of String(descoberta).split(/\r?\n/)){
  const h=linha.match(/^(?:Device|Dispositivo):\s*(?:uri\s*=\s*)?(.+)$/i);if(h){atual={uri:h[1].trim(),id:''};dispositivos.set(atual.uri,atual);continue;}
  const id=linha.match(/^\s*device-id\s*=\s*(.+)$/i);if(id&&atual)atual.id=id[1].trim();
 }
 const resultado=new Map();
 for(const linha of String(filas).split(/\r?\n/)){
  const m=linha.match(/^(?:device for|dispositivo para) (.+?):\s*(\S+)/i);if(!m)continue;
  const d=dispositivos.get(m[2]);
  const valido=d && /^usb:\/\//i.test(d.uri) && d.id;
  resultado.set(m[1],{v:1,driver:'cups',port:m[2],device:valido?d.id:'',method:valido?'usb_device_id':'unknown',response:valido?d.id:'',observed_at:valido?agora:new Date().toISOString()});
 }
 return resultado;
}
module.exports={observacoesCups};
