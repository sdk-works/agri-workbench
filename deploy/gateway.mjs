import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(process.env.WEB_ROOT),port=Number(process.env.WEB_PORT||8080);
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon',
// 证书必须用 x-x509-ca-cert：Android Chrome 看到这个类型才会直接调起系统
// 「安装证书」界面。给成 application/octet-stream 时它只当普通二进制下载，
// 手机上表现为"点链接下载不动"。
'.crt':'application/x-x509-ca-cert','.cer':'application/x-x509-ca-cert','.pem':'application/x-x509-ca-cert',
'.txt':'text/plain; charset=utf-8'};
http.createServer((req,res)=>{
 let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400).end();return;}
 if(pathname==='/cf-url.txt'){
  // 当前 Cloudflare 隧道地址（云端 nginx 实时维护，隧道重启后会变）。
  // 入口页 entry.html 读它来给出「一键用安全连接进入」的按钮。
  const up=http.request({hostname:'42.193.104.148',port:80,path:'/cf-url.txt',method:'GET',headers:{Host:'42.193.104.148'}},r=>{
   const chunks=[];r.on('data',c=>chunks.push(c));r.on('end',()=>{
    const body=Buffer.concat(chunks).toString('utf8').trim();
    res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*','X-Content-Type-Options':'nosniff'});
    res.end(body);
   });
  });
  up.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('');});
  up.setTimeout(8000,()=>up.destroy());up.end();return;
 }
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
 const ext=path.extname(file).toLowerCase();
 const headers={'Content-Type':mime[ext]||'application/octet-stream','Content-Length':stat.size,'X-Content-Type-Options':'nosniff','Cache-Control':file.endsWith('.html')?'no-cache':'public, max-age=3600'};
 // 证书给个文件名：部分安卓浏览器下载后不保留路径名，文件管理器里找不到
 if(ext==='.crt'||ext==='.cer'||ext==='.pem')headers['Content-Disposition']='attachment; filename="jingyang-ca.crt"';
 res.writeHead(200,headers);
 if(req.method==='HEAD'){res.end();return;}const stream=fs.createReadStream(file);stream.on('error',()=>res.destroy());stream.pipe(res);
 });
}).listen(port,process.env.WEB_HOST||'127.0.0.1',()=>console.log('Workstation gateway ready',port));
