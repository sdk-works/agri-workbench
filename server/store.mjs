import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(filename) {
    if(filename!==':memory:') fs.mkdirSync(path.dirname(filename), {recursive:true});
    this.db=new DatabaseSync(filename);
    const version=this.db.prepare('PRAGMA user_version').get().user_version;
    if(version>1){this.db.close();throw new Error('数据库版本比当前程序更新，请勿降级打开')}
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS comparisons(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, comparison_id TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS exports(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  get(id){const row=this.db.prepare('SELECT body FROM comparisons WHERE id=?').get(id);return row?JSON.parse(row.body):null}
  all(){return this.db.prepare('SELECT body FROM comparisons ORDER BY created_at DESC,id DESC').all().map(r=>JSON.parse(r.body))}
  create(record){this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('INSERT INTO comparisons VALUES(?,?,?)').run(record.id,record.created_at,JSON.stringify(record));this.audit(record,'created');this.db.exec('COMMIT');return record}catch(e){this.db.exec('ROLLBACK');throw e}}
  audit(record,action){this.db.prepare('INSERT INTO audit(comparison_id,action,created_at,snapshot) VALUES(?,?,?,?)').run(record.id,action,new Date().toISOString(),JSON.stringify(record))}
  update(id,fn,action='updated'){
    this.db.exec('BEGIN IMMEDIATE');try{const r=this.get(id);if(!r)throw Object.assign(new Error('记录不存在'),{status:404});fn(r);r.version++;r.updated_at=new Date().toISOString();this.db.prepare('UPDATE comparisons SET body=? WHERE id=?').run(JSON.stringify(r),id);this.audit(r,action);this.db.exec('COMMIT');return r}catch(e){this.db.exec('ROLLBACK');throw e}
  }
  saveExport(record){this.db.prepare('INSERT INTO exports VALUES(?,?,?,?)').run(record.id,record.created_at,record.kind,JSON.stringify(record));return record}
  async backupTo(filename){fs.mkdirSync(path.dirname(filename),{recursive:true});await backup(this.db,filename);return filename}
  close(){this.db.close()}
}
