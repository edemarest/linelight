export default function Head() {
  const script = `(function(){
    try{
      if(window.__earlyClientErrorInstalled) return; window.__earlyClientErrorInstalled = true;
      function sendPayload(p){
        try{
          var url = (location && location.origin ? location.origin : "") + "/api/client-error";
          var body = typeof p === 'string' ? p : JSON.stringify(p);
          if(navigator && navigator.sendBeacon){ try{ navigator.sendBeacon(url, body); return; }catch(e){} }
          try{ fetch(url, {method:'POST', keepalive:true, headers:{'Content-Type':'application/json'}, body: body}); }catch(e){}
        }catch(e){}
      }
      window.addEventListener('error', function(ev){
        try{
          var info = {type:'error', message: ev && ev.message || '', filename: ev && ev.filename || '', lineno: ev && ev.lineno || 0, colno: ev && ev.colno || 0, stack: ev && ev.error && ev.error.stack || null, ts: Date.now()};
          sendPayload(info);
        }catch(e){}
      }, true);
      window.addEventListener('unhandledrejection', function(ev){
        try{
          var r = ev && ev.reason;
          var info = {type:'unhandledrejection', message: (r && r.message) || String(r) || '', stack: (r && r.stack) || null, ts: Date.now()};
          sendPayload(info);
        }catch(e){}
      }, true);
    }catch(e){}
  })();`;

  return (
    <head>
      <script dangerouslySetInnerHTML={{ __html: script }} />
    </head>
  );
}
