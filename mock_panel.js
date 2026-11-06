// Mock-mode only: simulated level boards plus a small control page on a separate port.
// Boards follow level_arduino/src/main.cpp: same message strings, LOCK_DOOR only succeeds with the door closed.
const http = require('http');

// A virtual board; feed(line) receives the raw "<level> : <message>" lines a real board would print
function createMockBoard(level, feed) {
  const b = { level, doorClosed: true, doorLocked: true, lockRequested: false, silent: false };
  // A silenced board keeps its port open but sends nothing (like the B board in the 2026-10-31 incident)
  const send = mess => setImmediate(() => { if (!b.silent) feed(`${level} : ${mess}`); });
  send('<3');
  setInterval(() => send('<3'), 1000); // firmware HEARTBEAT_INTERVAL
  const lockIfRequestedAndClosed = () => {
    if (b.lockRequested && b.doorClosed) {
      b.doorLocked = true;
      send('DOOR LOCKED');
      b.lockRequested = false;
    } else {
      send("CAN'T LOCK DOOR");
      send('door_lock_requested = ' + (b.lockRequested ? 'true' : 'false'));
      send('door_closed = ' + (b.doorClosed ? 'true' : 'false'));
    }
  };
  const unlock = () => {
    b.lockRequested = false;
    b.doorLocked = false;
    send('DOOR UNLOCKED');
  };
  const doorChanged = closed => {
    b.doorClosed = closed;
    send(closed ? 'DOOR CLOSED' : 'DOOR OPEN');
    lockIfRequestedAndClosed();
    if (!b.doorClosed && b.doorLocked) {
      send('ALERT : DOOR OPEN WHILE LOCKED');
      unlock();
    }
  };
  b.port = {
    isOpen: true,
    settings: { path: `Mock_${level}` },
    write: (data, cb) => {
      const cmd = String(data).trim();
      console.log(`Mock write to ${level}: ${cmd}`);
      if (cmd === 'UNLOCK_DOOR') unlock();
      else if (cmd === 'LOCK_DOOR') { b.lockRequested = true; send('DOOR LOCK REQUESTED'); lockIfRequestedAndClosed(); }
      if (cb) cb(null);
    }
  };
  // Panel actions. A locked door cannot be opened normally (magnet holds it); force open breaks it open.
  b.action = act => {
    if (act === 'open') { if (b.doorLocked) return 'door is locked'; if (b.doorClosed) doorChanged(false); }
    else if (act === 'force') { if (b.doorClosed) doorChanged(false); }
    else if (act === 'close') { if (!b.doorClosed) doorChanged(true); }
    else if (act === 'call') send('call_button_pressed');
    else if (act === 'silence') { b.silent = !b.silent; console.log(`Mock board ${level} ${b.silent ? 'SILENCED' : 'back'}`); send('<3'); }
    else return 'unknown action';
    return null;
  };
  return b;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Lift mock panel</title>
<style>body{font-family:sans-serif;margin:20px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 10px}
.on{background:#cfc}.off{background:#fcc}button{margin:2px}#lift{margin:10px 0;font-weight:bold}#err{color:#c00}
#strip{height:14px;width:420px;border-radius:7px;margin:8px 0;background:#333;transition:all .3s}#strip.lit{background:linear-gradient(90deg,#fff6c0,#ffe066,#fff6c0);box-shadow:0 0 18px 6px #ffd84d}</style></head>
<body><h2>Lift mock panel</h2><div id="mode" style="color:#c60;font-weight:bold"></div><div id="lift"></div><div>LED strip: <span id="lightTxt"></span></div><div id="strip"></div><div id="err"></div>
<table><thead><tr><th>Level</th><th>Lift</th><th>Door</th><th>Lock</th><th>Actions</th></tr></thead><tbody id="rows"></tbody></table>
<script>
async function act(l,a){const r=await fetch('/action/'+l+'/'+a,{method:'POST'});const j=await r.json();document.getElementById('err').textContent=j.error||'';refresh();}
async function refresh(){try{const s=await (await fetch('/state')).json();
document.getElementById('mode').textContent=(s.fault?'FAULT: '+s.fault.reason+' ':'')+(s.maintenance&&s.maintenance.enabled?'MAINTENANCE MODE until '+new Date(s.maintenance.until).toLocaleTimeString():'');
document.getElementById('lift').textContent='Lift: '+s.liftState+' | position '+s.currentPosition+' | target '+s.targetLevel+' | '+s.displayMessage;
document.getElementById('strip').className=s.light?'lit':'';document.getElementById('lightTxt').textContent=s.light?'ON':'OFF';
document.getElementById('rows').innerHTML=s.levels.slice().reverse().map(l=>'<tr><td>'+l.level+'</td>'+
'<td class="'+(l.liftHere?'on':'')+'">'+(l.liftHere?'HERE':'away')+(l.silent?' <b>(SILENT)</b>':'')+'</td>'+
'<td class="'+(l.doorClosed?'on':'off')+'">'+(l.doorClosed?'closed':'OPEN')+'</td>'+
'<td class="'+(l.doorLocked?'on':'off')+'">'+(l.doorLocked?'locked':(l.lockRequested?"lock requested (can't lock)":'unlocked'))+'</td>'+
'<td><button onclick="act(\\''+l.level+'\\',\\'open\\')">Open door</button><button onclick="act(\\''+l.level+'\\',\\'force\\')">Force open</button>'+
'<button onclick="act(\\''+l.level+'\\',\\'close\\')">Close door</button><button onclick="act(\\''+l.level+'\\',\\'call\\')">Call button</button><button onclick="act(\\''+l.level+'\\',\\'silence\\')">'+(l.silent?'Unsilence board':'Silence board')+'</button></td></tr>').join('');
}catch(e){document.getElementById('err').textContent='server unreachable';}}
setInterval(refresh,500);refresh();
</script></body></html>`;

// getStatus() returns { light (0/1), liftState, currentPosition, targetLevel, displayMessage, presence: {level: bool} }
function startMockPanel(port, boards, getStatus) {
  http.createServer((req, res) => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const m = req.url.match(/^\/action\/([^/]+)\/([a-z]+)$/);
    if (req.method === 'POST' && m) {
      const b = boards[decodeURIComponent(m[1])];
      if (!b) return json(404, { error: 'unknown level' });
      const err = b.action(m[2]);
      return json(err ? 409 : 200, err ? { error: `${b.level}: ${err}` } : { ok: true });
    }
    if (req.url === '/state') {
      const s = getStatus();
      return json(200, { ...s, levels: Object.values(boards).map(b => ({
        level: b.level, silent: b.silent, doorClosed: b.doorClosed, doorLocked: b.doorLocked, lockRequested: b.lockRequested, liftHere: !!s.presence[b.level]
      })) });
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PAGE);
  }).listen(port, () => console.log(`Mock panel running on http://localhost:${port}`));
}

module.exports = { createMockBoard, startMockPanel };
