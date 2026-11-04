#!/usr/bin/env python3
"""
wizhub - one control surface for your Philips WiZ WiFi bulbs. Local, no cloud.

  python3 wizhub.py discover [--subnet 192.168.1.0/24]
  python3 wizhub.py serve [--port 8080]          # the dashboard (recommended)
  python3 wizhub.py list
  python3 wizhub.py on|off|toggle <name|all>
  python3 wizhub.py set <name|all> [--brightness 10-100] [--temp 2200-6500]
                                   [--color #ff8800] [--scene 6]
  python3 wizhub.py effect chase [--speed 1.2] [--color "#00aaff"]   # Ctrl-C to stop
  python3 wizhub.py rename <name|mac> "New name"

Python 3.8+, standard library only.
"""
import argparse, colorsys, ipaddress, json, math, os, random, socket, sys, threading, time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("WIZ_PORT", 38899))
DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bulbs.json")
TICK = 0.12  # seconds between animation frames (~8 fps per bulb, safe for WiZ)

SCENES = {
    1: "Ocean", 2: "Romance", 3: "Sunset", 4: "Party", 5: "Fireplace", 6: "Cozy",
    7: "Forest", 8: "Pastel colors", 9: "Wake up", 10: "Bedtime", 11: "Warm white",
    12: "Daylight", 13: "Cool white", 14: "Night light", 15: "Focus", 16: "Relax",
    17: "True colors", 18: "TV time", 19: "Plantgrowth", 20: "Spring", 21: "Summer",
    22: "Fall", 23: "Deepdive", 24: "Jungle", 25: "Mojito", 26: "Club",
    27: "Christmas", 28: "Halloween", 29: "Candlelight", 30: "Golden white",
    31: "Pulse", 32: "Steampunk",
}
EFFECTS = [
    ("solid", "Sync", "Every bulb, one colour"),
    ("chase", "Chase", "A light travels along the row"),
    ("bounce", "Bounce", "Back and forth, end to end"),
    ("wave", "Wave", "A soft swell rolling through"),
    ("rainbow", "Rainbow", "Hues roll across the bulbs"),
    ("breathe", "Breathe", "All bulbs pulse together"),
    ("candle", "Candle", "Warm, uneven flicker"),
    ("party", "Party", "Random colour bursts"),
    ("sunrise", "Sunrise", "Slow warm-up over five minutes"),
]


# ------------------------------------------------------------ low level UDP
def udp(ip, msg, tries=4, timeout=0.8):
    """Send JSON, wait for the reply, retry on loss (this is what the app lacks)."""
    data = json.dumps(msg).encode()
    for _ in range(tries):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(timeout)
        try:
            s.sendto(data, (ip, PORT))
            raw, _ = s.recvfrom(4096)
            return json.loads(raw)
        except (socket.timeout, OSError, ValueError):
            pass
        finally:
            s.close()
    return None


_fire_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)


def fire(ip, params):
    """Fire-and-forget setPilot, used by animations (a lost frame is replaced by the next)."""
    try:
        _fire_sock.sendto(json.dumps({"method": "setPilot", "params": params}).encode(), (ip, PORT))
    except OSError:
        pass


def discover(subnet=None, wait=2.5):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    s.bind(("", 0))
    s.settimeout(0.3)
    payload = json.dumps({"method": "getPilot", "params": {}}).encode()
    if subnet:
        net = ipaddress.ip_network(subnet, strict=False)
        targets = [str(net.network_address)] if net.prefixlen == 32 else [str(h) for h in net.hosts()]
    else:
        targets = ["255.255.255.255"]
    found, end, last = {}, time.time() + wait, 0
    while time.time() < end:
        if time.time() - last > 1:
            for t in targets:
                try:
                    s.sendto(payload, (t, PORT))
                except OSError:
                    pass
            last = time.time()
        try:
            raw, (ip, _) = s.recvfrom(4096)
            res = json.loads(raw).get("result", {})
            if res.get("mac"):
                found[res["mac"]] = ip
        except (socket.timeout, ValueError):
            pass
    s.close()
    return found


# ------------------------------------------------------------ storage
def load():
    try:
        with open(DB) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save(db):
    with open(DB, "w") as f:
        json.dump(db, f, indent=2)


def fetch_modules(db):
    """Learn each bulb's model (RGB / tunable white / dimmable white)."""
    todo = [m for m, b in db.items() if not b.get("module")]

    def one(m):
        r = udp(db[m]["ip"], {"method": "getSystemConfig", "params": {}}, tries=2)
        return m, (r or {}).get("result", {}).get("moduleName", "")
    with ThreadPoolExecutor(max_workers=16) as ex:
        for m, mod in ex.map(one, todo):
            if mod:
                db[m]["module"] = mod
    return db


def refresh(subnet=None):
    db = load()
    for mac, ip in discover(subnet).items():
        db.setdefault(mac, {"name": f"Bulb {mac[-4:]}"})["ip"] = ip
    fetch_modules(db)
    save(db)
    return db


def caps(b):
    u = (b.get("module") or "").upper()
    if not u or "RGB" in u:
        return "rgb"  # unknown -> try colour
    return "tw" if "TW" in u else "dw"


def ordered(db):
    return sorted(db, key=lambda m: (db[m].get("order", 999), db[m]["name"].lower()))


def resolve(db, who):
    if who in ("all", "*"):
        return ordered(db)
    w = who.lower()
    exact = [m for m, b in db.items() if b["name"].lower() == w or m == w]
    return exact or [m for m, b in db.items() if w in b["name"].lower()]


# ------------------------------------------------------------ one-shot control
def get_state(ip):
    r = udp(ip, {"method": "getPilot", "params": {}})
    return r.get("result") if r else None


def hex2rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def set_bulb(b, state=None, brightness=None, temp=None, color=None, scene=None):
    p = {}
    if state is not None:
        p["state"] = bool(state)
    if brightness is not None:
        p["dimming"] = max(10, min(100, int(brightness)))
    if temp is not None:
        p["temp"] = max(2200, min(6500, int(temp)))
    if color and caps(b) == "rgb":
        p["r"], p["g"], p["b"] = hex2rgb(color)
    if scene is not None:
        p["sceneId"] = int(scene)
    if not p:
        return False
    if state is None and any(k in p for k in ("r", "temp", "sceneId")):
        p["state"] = True
    r = udp(b["ip"], {"method": "setPilot", "params": p})
    return bool(r and r.get("result", {}).get("success"))


def apply_many(db, macs, **kw):
    with ThreadPoolExecutor(max_workers=16) as ex:
        return dict(zip(macs, ex.map(lambda m: set_bulb(db[m], **kw), macs)))


def probe(db):
    def one(item):
        m, b = item
        st = get_state(b["ip"])
        return {"mac": m, "online": st is not None, "state": st}
    with ThreadPoolExecutor(max_workers=16) as ex:
        return list(ex.map(one, db.items()))


# ------------------------------------------------------------ effects
def hsv(h, s=1.0, v=1.0):
    r, g, b = colorsys.hsv_to_rgb(h % 1.0, s, v)
    return (int(r * 255), int(g * 255), int(b * 255))


def render(effect, t, n, p):
    """Return [(rgb, dimming)] for n bulbs at time t (seconds)."""
    sp = float(p["speed"])
    mx = max(10, min(100, int(p["brightness"])))
    base = hex2rgb(p["color"])

    def dim(x):
        return int(10 + (mx - 10) * max(0.0, min(1.0, x)))

    if effect in ("chase", "bounce") and n < 2:
        effect = "breathe"
    out = []
    for i in range(n):
        if effect == "chase":
            pos = (t * sp * 1.6) % n
            d = abs(i - pos)
            d = min(d, n - d)
            out.append((base, dim(1 - d / 1.3)))
        elif effect == "bounce":
            x = (t * sp * 0.7) % 2
            x = 2 - x if x > 1 else x
            out.append((base, dim(1 - abs(i - x * (n - 1)) / 1.3)))
        elif effect == "wave":
            x = 0.5 + 0.5 * math.sin(t * sp * 2.0 - i * 2 * math.pi / n)
            out.append((base, dim(x)))
        elif effect == "rainbow":
            out.append((hsv(t * sp * 0.08 + i / n), dim(1)))
        elif effect == "breathe":
            out.append((base, dim(0.5 + 0.5 * math.sin(t * sp * 1.6))))
        elif effect == "candle":
            x = 0.62 + 0.22 * math.sin(t * 7 * sp + i * 1.7) + 0.16 * math.sin(t * 13 * sp + i * 3.1)
            out.append(((255, 147, 41), dim(x)))
        elif effect == "party":
            rng = random.Random(int(t * sp * 2.5) * 131 + i)
            out.append((hsv(rng.random()), dim(1)))
        elif effect == "sunrise":
            k = min(1.0, t / (300.0 / sp))
            out.append(((255, int(40 + k * 170), int(k * 110)), dim(0.05 + 0.95 * k)))
        else:  # solid / sync
            out.append((base, dim(1)))
    return out


class Engine:
    def __init__(self):
        self.lock = threading.Lock()
        self.p = {"effect": None, "speed": 1.0, "brightness": 100, "color": "#ff7a1a"}
        self.frame = {}
        self.thread = None
        self.evt = threading.Event()

    def running(self):
        return self.thread is not None and self.thread.is_alive() and not self.evt.is_set()

    def start(self, **kw):
        with self.lock:
            self.p.update({k: v for k, v in kw.items() if v is not None})
            if self.running():
                return
            self.evt = threading.Event()
            self.thread = threading.Thread(target=self._loop, args=(self.evt,), daemon=True)
            self.thread.start()

    def stop(self):
        self.evt.set()
        self.frame = {}
        self.p["effect"] = None

    def _loop(self, evt):
        t0, last_eff, last_load, db, macs = time.time(), None, 0, {}, []
        while not evt.is_set():
            tick = time.time()
            if tick - last_load > 3:
                db = load()
                macs = ordered(db)
                last_load = tick
            eff = self.p["effect"]
            if eff != last_eff:
                t0, last_eff = tick, eff
            if eff and macs:
                out = {}
                for m, (rgb, d) in zip(macs, render(eff, tick - t0, len(macs), self.p)):
                    if caps(db[m]) == "rgb":
                        fire(db[m]["ip"], {"state": True, "r": rgb[0], "g": rgb[1], "b": rgb[2], "dimming": d})
                    else:
                        fire(db[m]["ip"], {"state": True, "dimming": d})
                    out[m] = [rgb[0], rgb[1], rgb[2], d]
                self.frame = out
            evt.wait(max(0.0, TICK - (time.time() - tick)))


ENGINE = Engine()


# ------------------------------------------------------------ web UI
HTML = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lights</title>
<style>
:root{--bg:#171a2e;--panel:#20243d;--line:#353b5e;--ink:#eceef8;--mute:#9aa1c4;--live:#ffffff}
*{box-sizing:border-box}
html{color-scheme:dark}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font:16px/1.45 ui-rounded,"SF Pro Rounded","Avenir Next",system-ui,sans-serif}
#spill{position:fixed;inset:0;pointer-events:none;transition:background .12s linear}
main{position:relative;max-width:980px;margin:0 auto;padding:22px 18px 70px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;justify-content:space-between}
h1{margin:0;font-size:30px;letter-spacing:-.02em}
h2{font-size:17px;margin:34px 0 12px;font-weight:600}
#sub{margin:2px 0 0;color:var(--mute);font-size:14px}
button,select,input{font:inherit;color:inherit}
button{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:8px 14px;cursor:pointer}
button:hover:not(:disabled){border-color:var(--mute)}
button:disabled{opacity:.4;cursor:default}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.bar{display:flex;gap:8px;flex-wrap:wrap}
#stage{display:flex;flex-wrap:wrap;justify-content:center;gap:18px 34px;padding:64px 0 14px}
.slot{display:flex;flex-direction:column;align-items:center;gap:8px;width:120px}
.orb{width:92px;height:92px;border-radius:50%;padding:0;background:#2a2f4e;border:1px solid var(--line);transition:background .12s,box-shadow .12s}
.orb.lit{border-color:transparent;background:radial-gradient(circle at 34% 28%,rgba(255,255,255,.8),var(--c) 46%);
 box-shadow:0 0 calc(16px + 54px*var(--k)) calc(2px + 14px*var(--k)) var(--c)}
.nm{width:100%;text-align:center;background:none;border:0;border-bottom:1px dashed transparent;padding:2px;font-weight:600}
.nm:hover,.nm:focus{border-bottom-color:var(--line);outline:none}
.mv{display:flex;gap:6px}
.mv button{padding:0 10px;height:26px;border-radius:8px;line-height:1}
.hint,.empty{color:var(--mute);font-size:13px;text-align:center;margin:0}
#tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px}
.tile{text-align:left;padding:12px 14px;border-radius:14px;display:flex;flex-direction:column;gap:2px}
.tile b{font-weight:600}.tile span{font-size:13px;color:var(--mute)}
.tile.on{border-color:var(--live);box-shadow:0 0 0 1px var(--live),0 0 22px -4px var(--live)}
.ctl{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px;margin-top:18px;align-items:end}
.ctl label{display:flex;flex-direction:column;gap:6px;font-size:14px;color:var(--mute)}
input[type=range]{width:100%;accent-color:var(--live)}
.pal{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.sw{width:28px;height:28px;border-radius:50%;padding:0;border:2px solid transparent}
.sw.on{border-color:#fff}
input[type=color]{width:34px;height:28px;padding:0;border:1px solid var(--line);border-radius:8px;background:none}
details{margin-top:34px}summary{cursor:pointer;font-weight:600;font-size:17px}
.rowb{display:grid;grid-template-columns:minmax(90px,1.2fr) 46px minmax(110px,2fr) 40px minmax(100px,1.2fr);gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}
.rowb select{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:5px 6px;min-width:0}
.tg{width:46px;height:26px;border-radius:13px;padding:0;position:relative}
.tg::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .12s}
.tg.on{background:var(--live)}.tg.on::after{left:23px}
#msg{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:8px 16px;border-radius:20px;font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none}
#msg.show{opacity:1}
@media(max-width:620px){.rowb{grid-template-columns:1fr 46px;}.rowb input[type=range],.rowb select{grid-column:1/-1}}
</style></head><body>
<div id="spill"></div>
<main>
<header>
 <div><h1>Lights</h1><p id="sub"></p></div>
 <div class="bar"><button id="allon">All on</button><button id="alloff">All off</button><button id="scan">Find bulbs</button></div>
</header>
<section id="stage" aria-label="Your bulbs"></section>
<p class="hint">Click a bulb to switch it. Use ‹ › to match the order of the bulbs in your room, because chase and wave follow it.</p>

<h2>Effects</h2>
<div id="tiles"></div>
<p class="hint" style="text-align:left;margin-top:8px">Click the active effect again to stop it. Bulbs keep their last colour.</p>
<div class="ctl">
 <label>Speed <input id="speed" type="range" min="0.2" max="3" step="0.1" value="1"></label>
 <label>Brightness <input id="bright" type="range" min="10" max="100" value="100"></label>
 <div class="pal" id="pal" role="group" aria-label="Colour"></div>
</div>

<details><summary>Each bulb</summary><div id="each"></div></details>
</main>
<div id="msg" role="status"></div>
<script>
const EFFECTS=__EFFECTS__, SCENES=__SCENES__;
const S={bulbs:[],live:{},eff:null,speed:1,bright:100,color:'#ff7a1a',running:false};
const PAL=['#ff7a1a','#ff3b6b','#a855f7','#3b82f6','#22d3ee','#34d399','#fde047','#ffffff'];
const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(p,b){try{const r=await fetch(p,{method:b?'POST':'GET',headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});return await r.json()}catch(e){toast('Lost connection to wizhub');return {}}}
function toast(t){const m=$('#msg');m.textContent=t;m.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>m.classList.remove('show'),2400)}
const debounce=(f,ms)=>{let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>f(...a),ms)}};

function liveFromState(st){
  if(!st||!st.state)return{on:false};
  let rgb;
  if(st.r||st.g||st.b)rgb=[st.r,st.g,st.b];
  else{const t=Math.max(0,Math.min(1,((st.temp||2700)-2200)/4300));rgb=[255,Math.round(170+t*70),Math.round(80+t*175)]}
  return{on:true,rgb,k:(st.dimming||100)/100};
}
function paint(){
  const spill=[];let sum=[0,0,0],n=0;
  S.bulbs.forEach(b=>{
    const el=document.getElementById('orb-'+b.mac);if(!el)return;
    const l=S.live[b.mac];
    if(l&&l.on){
      el.style.setProperty('--c','rgb('+l.rgb.join(',')+')');el.style.setProperty('--k',l.k);el.classList.add('lit');
      const r=el.getBoundingClientRect();
      spill.push(`radial-gradient(circle at ${r.left+r.width/2}px ${r.top+r.height/2}px, rgba(${l.rgb.join(',')},${(.10+.28*l.k).toFixed(2)}), transparent 540px)`);
      l.rgb.forEach((v,i)=>sum[i]+=v);n++;
    }else el.classList.remove('lit');
  });
  $('#spill').style.background=spill.join(',')||'none';
  if(n){const a=sum.map(v=>Math.min(255,Math.round(v/n*1.0)));document.documentElement.style.setProperty('--live','rgb('+a.join(',')+')')}
  else document.documentElement.style.setProperty('--live','#ffffff');
  document.querySelectorAll('.tg').forEach(t=>{const l=S.live[t.dataset.mac];t.classList.toggle('on',!!(l&&l.on))});
}
function renderStage(){
  const st=$('#stage');st.innerHTML='';
  $('#sub').textContent=S.bulbs.length?S.bulbs.length+(S.bulbs.length===1?' bulb':' bulbs')+' on your network':'No bulbs yet';
  if(!S.bulbs.length){st.innerHTML='<p class="empty">No bulbs saved yet. Press Find bulbs.</p>';return}
  S.bulbs.forEach((b,i)=>{
    const d=document.createElement('div');d.className='slot';
    d.innerHTML=`<button class="orb" id="orb-${b.mac}" aria-label="Switch ${esc(b.name)}"></button>
    <input class="nm" value="${esc(b.name)}" aria-label="Bulb name">
    <div class="mv"><button aria-label="Move ${esc(b.name)} left" ${i?'':'disabled'}>‹</button><button aria-label="Move ${esc(b.name)} right" ${i<S.bulbs.length-1?'':'disabled'}>›</button></div>`;
    d.querySelector('.orb').onclick=()=>{const l=S.live[b.mac];send([b.mac],{state:!(l&&l.on)})};
    d.querySelector('.nm').onchange=async e=>{await api('/api/rename',{mac:b.mac,name:e.target.value});b.name=e.target.value;renderEach()};
    const [lb,rb]=d.querySelectorAll('.mv button');
    lb.onclick=()=>move(i,-1);rb.onclick=()=>move(i,1);
    st.appendChild(d);
  });
}
function renderEach(){
  $('#each').innerHTML='';
  S.bulbs.forEach(b=>{
    const r=document.createElement('div');r.className='rowb';
    r.innerHTML=`<span>${esc(b.name)}</span><button class="tg" data-mac="${b.mac}" aria-label="Switch ${esc(b.name)}"></button>
    <input type="range" min="10" max="100" value="100" aria-label="Brightness of ${esc(b.name)}">
    ${b.caps==='rgb'?'<input type="color" value="#ffffff" aria-label="Colour">':'<span></span>'}
    <select aria-label="Scene"><option value="">Scene…</option>${Object.entries(SCENES).map(([i,n])=>`<option value="${i}">${n}</option>`).join('')}</select>`;
    r.querySelector('.tg').onclick=()=>{const l=S.live[b.mac];send([b.mac],{state:!(l&&l.on)})};
    r.querySelector('input[type=range]').oninput=debounce(e=>send([b.mac],{brightness:+e.target.value}),150);
    const c=r.querySelector('input[type=color]');if(c)c.onchange=e=>send([b.mac],{color:e.target.value});
    r.querySelector('select').onchange=e=>{if(e.target.value)send([b.mac],{scene:+e.target.value})};
    $('#each').appendChild(r);
  });
}
function renderTiles(){
  $('#tiles').innerHTML=EFFECTS.map(([id,name,desc])=>`<button class="tile ${S.eff===id?'on':''}" data-id="${id}" aria-pressed="${S.eff===id}"><b>${name}</b><span>${desc}</span></button>`).join('');
  document.querySelectorAll('.tile').forEach(t=>t.onclick=()=>setEffect(t.dataset.id));
  $('#pal').innerHTML=PAL.map(c=>`<button class="sw ${c===S.color?'on':''}" style="background:${c}" data-c="${c}" aria-label="Colour ${c}"></button>`).join('')+`<input type="color" id="pick" value="${S.color}" aria-label="Pick colour">`;
  document.querySelectorAll('.sw').forEach(s=>s.onclick=()=>setColor(s.dataset.c));
  $('#pick').onchange=e=>setColor(e.target.value);
}
async function setEffect(id){
  if(S.eff===id){S.eff=null;await api('/api/effect',{effect:'stop'});renderTiles();toast('Stopped');return}
  S.eff=id;renderTiles();pushEffect();
}
async function pushEffect(){await api('/api/effect',{effect:S.eff,speed:S.speed,brightness:S.bright,color:S.color});if(S.eff==='solid')setTimeout(doProbe,400)}
function setColor(c){S.color=c;if(!S.eff)S.eff='solid';renderTiles();pushEffect()}
async function send(macs,params){
  S.eff=null;renderTiles();
  const r=await api('/api/set',{macs,params});
  if(r.results&&Object.values(r.results).some(x=>!x))toast('A bulb did not reply');
  setTimeout(doProbe,300);
}
async function move(i,d){
  const j=i+d;[S.bulbs[i],S.bulbs[j]]=[S.bulbs[j],S.bulbs[i]];
  await api('/api/order',{macs:S.bulbs.map(b=>b.mac)});renderStage();renderEach();paint();
}
async function doProbe(){
  if(S.running)return;
  const r=await api('/api/probe');if(!Array.isArray(r))return;
  r.forEach(x=>S.live[x.mac]=x.online?liveFromState(x.state):{on:false});paint();
}
async function loop(){
  const r=await api('/api/live');
  S.running=!!r.running;
  if(r.running){
    for(const m in r.frame){const f=r.frame[m];S.live[m]={on:true,rgb:[f[0],f[1],f[2]],k:f[3]/100}}
    if(S.eff!==r.effect){S.eff=r.effect;renderTiles()}
    paint();
  }
  setTimeout(loop,r.running?140:700);
}
async function init(){
  const r=await api('/api/state');
  S.bulbs=r.bulbs||[];const e=r.engine||{};
  S.eff=e.effect||null;S.speed=e.speed??1;S.bright=e.brightness??100;S.color=e.color||S.color;
  $('#speed').value=S.speed;$('#bright').value=S.bright;
  renderStage();renderEach();renderTiles();await doProbe();loop();setInterval(doProbe,6000);
}
$('#speed').oninput=debounce(e=>{S.speed=+e.target.value;if(S.eff)pushEffect()},120);
$('#bright').oninput=debounce(e=>{S.bright=+e.target.value;if(S.eff)pushEffect();else api('/api/set',{macs:'all',params:{brightness:S.bright}}).then(()=>setTimeout(doProbe,300))},150);
$('#allon').onclick=()=>send('all',{state:true});
$('#alloff').onclick=()=>send('all',{state:false});
$('#scan').onclick=async()=>{const b=$('#scan');b.disabled=true;b.textContent='Searching…';await api('/api/discover',{});b.disabled=false;b.textContent='Find bulbs';await init();toast('Done')};
window.addEventListener('scroll',paint,{passive:true});window.addEventListener('resize',paint);
init();
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        try:
            return json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return {}

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/":
            page = (HTML.replace("__SCENES__", json.dumps({str(k): v for k, v in SCENES.items()}))
                        .replace("__EFFECTS__", json.dumps(EFFECTS)))
            self._send(200, page, "text/html; charset=utf-8")
        elif path == "/api/state":
            db = load()
            if any(not b.get("module") for b in db.values()):
                db = fetch_modules(db)
                save(db)
            bulbs = [{"mac": m, "name": db[m]["name"], "ip": db[m]["ip"], "caps": caps(db[m])} for m in ordered(db)]
            self._send(200, json.dumps({"bulbs": bulbs, "engine": ENGINE.p if ENGINE.running() else {**ENGINE.p, "effect": None}}))
        elif path == "/api/probe":
            self._send(200, json.dumps(probe(load())))
        elif path == "/api/live":
            run = ENGINE.running()
            self._send(200, json.dumps({"running": run, "effect": ENGINE.p["effect"] if run else None,
                                        "frame": ENGINE.frame if run else {}}))
        else:
            self._send(404, "{}")

    def do_POST(self):
        body, db = self._body(), load()
        path = self.path.split("?")[0]
        if path == "/api/set":
            ENGINE.stop()
            macs = ordered(db) if body.get("macs") == "all" else [m for m in body.get("macs", []) if m in db]
            self._send(200, json.dumps({"results": apply_many(db, macs, **body.get("params", {}))}))
        elif path == "/api/effect":
            eff = body.get("effect")
            if eff in (None, "stop"):
                ENGINE.stop()
            elif eff == "solid":
                ENGINE.stop()
                ENGINE.p.update({k: body[k] for k in ("speed", "brightness", "color") if k in body})
                apply_many(db, ordered(db), state=True, brightness=body.get("brightness", 100),
                           color=body.get("color"))
            elif eff in {e[0] for e in EFFECTS}:
                ENGINE.start(effect=eff, **{k: body.get(k) for k in ("speed", "brightness", "color")})
            self._send(200, "{}")
        elif path == "/api/order":
            for i, m in enumerate(body.get("macs", [])):
                if m in db:
                    db[m]["order"] = i
            save(db)
            self._send(200, "{}")
        elif path == "/api/discover":
            self._send(200, json.dumps({"count": len(refresh())}))
        elif path == "/api/rename":
            if body.get("mac") in db and str(body.get("name", "")).strip():
                db[body["mac"]]["name"] = body["name"].strip()
                save(db)
            self._send(200, "{}")
        else:
            self._send(404, "{}")


# ------------------------------------------------------------ CLI
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("discover"); d.add_argument("--subnet")
    sub.add_parser("list")
    for c in ("on", "off", "toggle"):
        sub.add_parser(c).add_argument("who")
    s = sub.add_parser("set"); s.add_argument("who")
    s.add_argument("--brightness", type=int); s.add_argument("--temp", type=int)
    s.add_argument("--color"); s.add_argument("--scene", type=int)
    r = sub.add_parser("rename"); r.add_argument("who"); r.add_argument("name")
    e = sub.add_parser("effect"); e.add_argument("name", choices=[x[0] for x in EFFECTS])
    e.add_argument("--speed", type=float, default=1.0); e.add_argument("--brightness", type=int, default=100)
    e.add_argument("--color", default="#ff7a1a")
    sv = sub.add_parser("serve"); sv.add_argument("--port", type=int, default=8080); sv.add_argument("--host", default="0.0.0.0")
    a = ap.parse_args()

    if a.cmd == "discover":
        db = refresh(a.subnet)
        print(f"{len(db)} bulb(s) known:")
        for m in ordered(db):
            b = db[m]
            print(f"  {b['name']:<20} {b['ip']:<15} {m}  {b.get('module', '')}")
        if not db:
            print("Nothing found. Check you're on the same WiFi, that 'Allow local communication' is ON in the\n"
                  "WiZ app (Settings > Security), and on macOS allow Terminal under Privacy > Local Network.\n"
                  "Or try: discover --subnet 192.168.1.0/24")
        return
    if a.cmd == "serve":
        print(f"Open http://localhost:{a.port}   (phone/tablet: http://<this-computer-ip>:{a.port})")
        try:
            ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()
        except KeyboardInterrupt:
            pass
        return

    db = load()
    if not db:
        sys.exit("No bulbs saved yet. Run: python3 wizhub.py discover")
    if a.cmd == "effect":
        ENGINE.start(effect=a.name, speed=a.speed, brightness=a.brightness, color=a.color)
        print(f"Running {a.name}. Ctrl-C to stop.")
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            ENGINE.stop()
        return
    if a.cmd == "list":
        names = {x["mac"]: x for x in probe(db)}
        for m in ordered(db):
            st = names[m]["state"] or {}
            print(f"  {db[m]['name']:<20} {db[m]['ip']:<15} " +
                  ("OFFLINE" if not names[m]["online"] else f"{'on ' if st.get('state') else 'off'} {st.get('dimming', '-')}%"))
        return
    macs = resolve(db, a.who)
    if not macs:
        sys.exit(f"No bulb matches '{a.who}'.")
    if a.cmd == "rename":
        db[macs[0]]["name"] = a.name; save(db); print("Renamed."); return
    if a.cmd == "toggle":
        res = {m: set_bulb(db[m], state=not (get_state(db[m]["ip"]) or {}).get("state", False)) for m in macs}
    elif a.cmd in ("on", "off"):
        res = apply_many(db, macs, state=(a.cmd == "on"))
    else:
        res = apply_many(db, macs, brightness=a.brightness, temp=a.temp, color=a.color, scene=a.scene)
    for m, ok in res.items():
        print(f"  {db[m]['name']:<20} {'ok' if ok else 'NO REPLY'}")


if __name__ == "__main__":
    main()
