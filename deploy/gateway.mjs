import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(process.env.WEB_ROOT),port=Number(process.env.WEB_PORT||8080);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
http.createServer((req,res)=>{
 let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400).end();return;}
 if(pathname.startsWith('/api/')){
  const proxy=http.request({hostname:'127.0.0.1',port:Number(process.env.API_PORT||8787),path:req.url,method:req.method,headers:req.headers},up=>{res.writeHead(up.statusCode,up.headers);up.pipe(res);});
  proxy.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Backend unavailable');});
  req.on('aborted',()=>proxy.destroy());res.on('close',()=>proxy.destroy());proxy.setTimeout(180000,()=>proxy.destroy());req.pipe(proxy);return;
 }
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405).end();return;}
 let file=path.resolve(root,'.'+pathname);
 if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 try{if(!fs.statSync(file).isFile())file=path.join(root,'index.html');}catch{file=path.join(root,'index.html');}
 fs.stat(file,(err,stat)=>{if(err){res.writeHead(404).end();return;}
 res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Content-Length':stat.size,'X-Content-Type-Options':'nosniff','Cache-Control':file.endsWith('.html')?'no-cache':'public, max-age=3600'});
 if(req.method==='HEAD'){res.end();return;}const stream=fs.createReadStream(file);stream.on('error',()=>res.destroy());stream.pipe(res);
 });
}).listen(port,process.env.WEB_HOST||'127.0.0.1',()=>console.log('Workstation gateway ready',port));
