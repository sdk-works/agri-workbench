import {Store} from './store.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source=process.env.DATA_PATH||path.join(root,'data/workbench.sqlite');
const target=process.argv[2];
if(!target)throw new Error('请提供备份目标，例如 node server/backup.mjs /backup/workbench.sqlite');
if(path.resolve(source)===path.resolve(target))throw new Error('备份目标不能是源数据库');
const fs=await import('node:fs');if(!fs.existsSync(source))throw new Error('源数据库不存在');if(fs.existsSync(target))throw new Error('备份文件已存在，请使用新名称');
const store=new Store(source);try{await store.backupTo(path.resolve(target));console.log('数据库一致性备份完成')}finally{store.close()}
