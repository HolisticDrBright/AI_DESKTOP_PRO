// One stored UTF-8 entry, fixed DOS date, no paths/extra entries or ZIP64.
// Deterministic bytes let S3 and Lambda prove the same compiled index.js shipped.
export function crc32(bytes) {
 let crc=0xffffffff;
 for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
 return (crc^0xffffffff)>>>0;
}
export function careMessagingZip(code){
 if(!Buffer.isBuffer(code)||!code.length||code.length>16*1024*1024)throw new Error('care_message_zip_refused');
 const name=Buffer.from('index.js'),checksum=crc32(code),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);
 local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(2048,6);local.writeUInt16LE(33,12);
 local.writeUInt32LE(checksum,14);local.writeUInt32LE(code.length,18);local.writeUInt32LE(code.length,22);local.writeUInt16LE(name.length,26);
 central.writeUInt32LE(0x02014b50);central.writeUInt16LE(0x0314,4);central.writeUInt16LE(20,6);central.writeUInt16LE(2048,8);central.writeUInt16LE(33,14);
 central.writeUInt32LE(checksum,16);central.writeUInt32LE(code.length,20);central.writeUInt32LE(code.length,24);central.writeUInt16LE(name.length,28);
 central.writeUInt32LE(0x81a40000,38);
 end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);
 end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(local.length+name.length+code.length,16);
 return Buffer.concat([local,name,code,central,name,end]);
}
