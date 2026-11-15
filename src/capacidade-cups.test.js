const {test}=require('node:test');const assert=require('node:assert/strict');const {observacoesCups}=require('./capacidade-cups');
test('nome LABEL herda identidade da URI USB descoberta, nunca do apelido',()=>{
 const filas='device for LABEL: usb://Zebra/GC420t?serial=ABC';
 const devices='Device: uri = usb://Zebra/GC420t?serial=ABC\n        device-id = MFG:Zebra;MDL:GC420t;CMD:EPL,ZPL;';
 // Saída de lpinfo -l -v usa URI como cabeçalho (normalizado abaixo).
 const r=observacoesCups(filas,devices);assert.equal(r.get('LABEL').method,'usb_device_id');assert.match(r.get('LABEL').response,/CMD:EPL,ZPL/);
 assert.equal(observacoesCups(filas,devices.replace('ABC','OUTRA')).get('LABEL').method,'unknown');
 const alterada=observacoesCups(filas.replace('ABC','OUTRA'),devices).get('LABEL');assert.equal(alterada.device,'');assert.match(alterada.port,/OUTRA/);
});

test('formato português real do CUPS com identidade EPL',()=>{
 const r=observacoesCups('dispositivo para LABEL: usb://Zebra/ZTC?serial=ABC','Dispositivo: uri = usb://Zebra/ZTC?serial=ABC\n        device-id = MANUFACTURER:Zebra Technologies ;COMMAND SET:EPL;MODEL:ZTC GC420t (EPL);');
 assert.equal(r.get('LABEL').method,'usb_device_id');
});
