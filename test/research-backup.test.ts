import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('online dry-run backup includes committed WAL data without checkpointing or mutating the source',async()=>{
  const root=mkdtempSync(join(tmpdir(),'omg-wal-copy-')),path=join(root,'source.sqlite');
  const writer=new DatabaseSync(path);
  let reader:DatabaseSync|undefined, copy:DatabaseSync|undefined;
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE evidence(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO evidence VALUES(1,\'committed in WAL\');');
    assert.ok(statSync(path+'-wal').size>0);
    reader=new DatabaseSync(path,{readOnly:true});
    await backup(reader,join(root,'copy.sqlite'));
    copy=new DatabaseSync(join(root,'copy.sqlite'),{readOnly:true});
    assert.equal(copy.prepare('SELECT value FROM evidence WHERE id=1').get()!['value'],'committed in WAL');
    writer.exec("INSERT INTO evidence VALUES(2,'after snapshot')");
    assert.equal(copy.prepare('SELECT count(*) n FROM evidence').get()!['n'],1);
    assert.equal(writer.prepare('SELECT count(*) n FROM evidence').get()!['n'],2);
  } finally {copy?.close();reader?.close();writer.close();rmSync(root,{recursive:true,force:true});}
});
