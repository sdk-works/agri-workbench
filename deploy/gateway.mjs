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
 // 浏览器若按 http 打开，页面就不是安全上下文：navigator.mediaDevices 直接不存在，
 // 麦克风报"没权限"、相机报"不是安全连接"，授权多少次都没用。
 // Cloudflare 边缘默认不强制升级，所以这里兜一层：只认公网域名，局域网 IP 直连不受影响。
 // 只跳页面，不碰 /api/：301 会把 POST 改成 GET，接口不能这么动。
 {
  const host=String(req.headers.host||'').replace(/:\d+$/,'');
  const visitor=String(req.headers['cf-visitor']||'');
  const proto=String(req.headers['x-forwarded-proto']||'').toLowerCase();
  const plain=/"scheme"\s*:\s*"http"/.test(visitor)||proto==='http';
  // 内网直连（回环/192.168/10.x/172.16-31）保持原样，跳了就没法在现场调数据
  const isLan=!host||host==='localhost'||/^127\./.test(host)||/^192\.168\./.test(host)||/^10\./.test(host)||/^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if(plain&&!isLan){
   res.writeHead(301,{'Location':'https://sundaokun.eu.cc'+req.url,'Cache-Control':'no-store','Connection':'close'});
   res.end();return;
  }
 }
 let file=path.resolve(root,'.'+pathname);
 if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
 const isAsset=pathname.startsWith('/assets/')||path.extname(pathname)!=='';const notFound=()=>{res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end('not found');};try{if(!fs.statSync(file).isFile()){if(isAsset)return notFound();file=path.join(root,'index.html');}}catch{if(isAsset)return notFound();file=path.join(root,'index.html');}
 fs.stat(file,(err,stat)=>{if(err){res.writeHead(404).end();return;}
 const ext=path.extname(file).toLowerCase();
 const headers={'Content-Type':mime[ext]||'application/octet-stream','Content-Length':stat.size,'X-Content-Type-Options':'nosniff','Cache-Control':file.endsWith('.html')?'no-cache':'public, max-age=3600'};
 // 证书给个文件名：部分安卓浏览器下载后不保留路径名，文件管理器里找不到
 if(ext==='.crt'||ext==='.cer'||ext==='.pem')headers['Content-Disposition']='attachment; filename="jingyang-ca.crt"';
 res.writeHead(200,headers);
 if(req.method==='HEAD'){res.end();return;}const stream=fs.createReadStream(file);stream.on('error',()=>res.destroy());stream.pipe(res);
 });
}).listen(port,process.env.WEB_HOST||'127.0.0.1',()=>console.log('Workstation gateway ready',port));
