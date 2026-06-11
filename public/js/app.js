/* ════════════════════════════════════════════════════════════
   AUDC VoIP Console — Multi-Channel Telephony Platform
   - WebRTC mesh per channel, per-channel PTT via GainNode
   - Per-channel volume / mute / stereo pan / recording
   - Private 1:1 calls, DTMF dialer, optional SIP trunk (PBX)
   - VOX (voice-activated transmit), demo simulation
════════════════════════════════════════════════════════════ */

const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const DTMF_KEYS = ['1','2','3','4','5','6','7','8','9','*','0','#'];
const DTMF_FREQS = {
  '1':[697,1209],'2':[697,1336],'3':[697,1477],
  '4':[770,1209],'5':[770,1336],'6':[770,1477],
  '7':[852,1209],'8':[852,1336],'9':[852,1477],
  '*':[941,1209],'0':[941,1336],'#':[941,1477],
};

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const fmtClock = d => [d.getHours(),d.getMinutes(),d.getSeconds()].map(v=>String(v).padStart(2,'0')).join(':');
const fmtDur = s => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;

function loadScript(src){
  return new Promise((res,rej)=>{
    if(document.querySelector(`script[src="${src}"]`)) return res();
    const s=document.createElement('script');
    s.src=src; s.onload=res; s.onerror=()=>rej(new Error('script load failed'));
    document.head.appendChild(s);
  });
}

/* ══════════════ Channel ══════════════ */
class Channel {
  constructor(id, name, sys){
    this.id=id; this.name=name; this.sys=sys;
    this.joined=false; this.muted=false; this.volume=1; this.pan=0;
    this.transmitting=false;
    this.peers={};            // peerId -> {name, pc, srcNode, speaking, audioEl, _demo}
    this.outGain=null; this.outStream=null; this.micSrc=null;
    this.rxBus=null; this.panner=null; this.analyser=null; this.vuAnim=null;
    this.recorder=null; this.recChunks=[]; this.recDest=null;
    this.log=[];
  }

  /* RX chain: peer sources → rxBus(vol/mute) → panner → analyser → master */
  ensureRxChain(){
    if(this.rxBus) return;
    const ctx=this.sys.audioCtx;
    this.rxBus=ctx.createGain();
    this.rxBus.gain.value=this.muted?0:this.volume;
    this.panner=ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
    if(this.panner.pan) this.panner.pan.value=this.pan;
    this.analyser=ctx.createAnalyser(); this.analyser.fftSize=256;
    this.rxBus.connect(this.panner);
    this.panner.connect(this.analyser);
    this.analyser.connect(this.sys.masterGain);
    this._startVU();
  }

  /* TX chain: mic → outGain(PTT 0/1) → dest → WebRTC track */
  ensureTxChain(){
    if(this.outStream) return;
    const ctx=this.sys.audioCtx;
    this.micSrc=ctx.createMediaStreamSource(this.sys.localStream);
    this.outGain=ctx.createGain();
    this.outGain.gain.value=0;
    const dest=ctx.createMediaStreamDestination();
    this.micSrc.connect(this.outGain);
    this.outGain.connect(dest);
    this.outStream=dest.stream;
  }

  rewireMic(){
    if(!this.outGain) return;
    try{ this.micSrc && this.micSrc.disconnect(); }catch(e){}
    this.micSrc=this.sys.audioCtx.createMediaStreamSource(this.sys.localStream);
    this.micSrc.connect(this.outGain);
  }

  addPeer(pid, pname, initiate){
    if(this.peers[pid]) return;
    this.ensureTxChain(); this.ensureRxChain();
    const pc=new RTCPeerConnection({iceServers:ICE});
    this.peers[pid]={name:pname,pc,srcNode:null,speaking:false,audioEl:null};
    const tr=this.outStream.getAudioTracks()[0];
    if(tr) pc.addTrack(tr,this.outStream);
    pc.ontrack=e=>this._incoming(pid,e.streams[0]);
    pc.onicecandidate=e=>{
      if(e.candidate) this.sys.socket.emit('signal',{to:pid,channelId:this.id,signal:{type:'candidate',candidate:e.candidate}});
    };
    if(initiate){
      pc.createOffer({offerToReceiveAudio:true})
        .then(o=>{pc.setLocalDescription(o);return o;})
        .then(o=>this.sys.socket.emit('signal',{to:pid,channelId:this.id,signal:{type:'offer',sdp:o}}));
    }
  }

  handleSignal(from,sig){
    if(sig.type==='offer'&&!this.peers[from]) this.addPeer(from,from,false);
    const p=this.peers[from]; if(!p||!p.pc) return;
    if(sig.type==='offer'){
      p.pc.setRemoteDescription(new RTCSessionDescription(sig.sdp))
        .then(()=>p.pc.createAnswer())
        .then(a=>{p.pc.setLocalDescription(a);return a;})
        .then(a=>this.sys.socket.emit('signal',{to:from,channelId:this.id,signal:{type:'answer',sdp:a}}));
    }else if(sig.type==='answer'){
      p.pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
    }else if(sig.type==='candidate'&&sig.candidate){
      p.pc.addIceCandidate(new RTCIceCandidate(sig.candidate)).catch(()=>{});
    }
  }

  _incoming(pid,stream){
    const p=this.peers[pid]; if(!p||!stream) return;
    this.ensureRxChain();
    try{ p.srcNode && p.srcNode.disconnect(); }catch(e){}
    p.srcNode=this.sys.audioCtx.createMediaStreamSource(stream);
    p.srcNode.connect(this.rxBus);
    if(!p.audioEl){ p.audioEl=new Audio(); p.audioEl.srcObject=stream; p.audioEl.muted=true; }
    this.sys.ui.refresh(this.id);
  }

  _startVU(){
    if(this.vuAnim) return;
    const tick=()=>{
      if(this.analyser){
        const d=new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteFrequencyData(d);
        const v=d.reduce((s,x)=>s+x,0)/d.length/128;
        const el=$('vu-'+this.id);
        if(el) el.style.width=Math.min(v*120,100)+'%';
      }
      this.vuAnim=requestAnimationFrame(tick);
    };
    this.vuAnim=requestAnimationFrame(tick);
  }

  setTX(v){ this.transmitting=v; if(this.outGain) this.outGain.gain.value=v?1:0; }
  applyMix(){
    if(this.rxBus) this.rxBus.gain.value=this.muted?0:this.volume;
    if(this.panner&&this.panner.pan) this.panner.pan.value=this.pan;
  }

  /* Recording: panner output (post-mix RX) + outGain (own TX) → MediaRecorder */
  startRecording(){
    if(this.recorder) return;
    this.ensureRxChain();
    const ctx=this.sys.audioCtx;
    this.recDest=ctx.createMediaStreamDestination();
    this.panner.connect(this.recDest);
    if(this.outGain) this.outGain.connect(this.recDest);
    this.recChunks=[];
    this.recorder=new MediaRecorder(this.recDest.stream);
    this.recorder.ondataavailable=e=>{ if(e.data.size) this.recChunks.push(e.data); };
    this.recorder.onstop=()=>{
      const blob=new Blob(this.recChunks,{type:'audio/webm'});
      const a=document.createElement('a');
      a.href=URL.createObjectURL(blob);
      a.download=`${this.id}_${new Date().toISOString().replace(/[:.]/g,'-')}.webm`;
      a.click();
      setTimeout(()=>URL.revokeObjectURL(a.href),5000);
      try{ this.panner.disconnect(this.recDest); }catch(e){}
      try{ this.outGain && this.outGain.disconnect(this.recDest); }catch(e){}
      this.recDest=null;
    };
    this.recorder.start(1000);
    this.sys.ui.feed(`<b>הקלטה</b> החלה בערוץ <span class="fc">${this.id}</span>`);
  }
  stopRecording(){
    if(!this.recorder) return;
    this.recorder.stop(); this.recorder=null;
    this.sys.ui.feed(`<b>הקלטה</b> נשמרה מערוץ <span class="fc">${this.id}</span>`);
  }

  removePeer(pid){
    const p=this.peers[pid]; if(!p) return;
    try{ p.pc && p.pc.close(); }catch(e){}
    try{ p.srcNode && p.srcNode.disconnect(); }catch(e){}
    delete this.peers[pid];
  }

  cleanup(){
    if(this.recorder) this.stopRecording();
    Object.keys(this.peers).forEach(id=>this.removePeer(id));
    try{ this.outGain && this.outGain.disconnect(); }catch(e){}
    try{ this.micSrc && this.micSrc.disconnect(); }catch(e){}
    this.outStream=null; this.outGain=null; this.micSrc=null;
  }

  isRX(){ return Object.values(this.peers).some(p=>p.speaking); }
}

/* ══════════════ Private 1:1 Calls ══════════════ */
class CallManager {
  constructor(sys){
    this.sys=sys;
    this.state='idle';   // idle|dialing|ringing|active
    this.peerId=null; this.peerName=null;
    this.pc=null; this.track=null; this.gain=null; this.srcNode=null;
    this.muted=false; this.startTs=0; this._timer=null;
    this._ringOsc=null; this._ringInt=null;
  }

  call(targetId,targetName){
    if(this.state!=='idle') return;
    this.state='dialing'; this.peerId=targetId; this.peerName=targetName;
    this.sys.socket.emit('call-user',{to:targetId});
    this.sys.ui.showCallCard(targetName,'מחייג...');
    this._ring(false);
  }

  onIncoming(from,fromName){
    if(this.state!=='idle'){ this.sys.socket.emit('call-response',{to:from,accept:false}); return; }
    this.state='ringing'; this.peerId=from; this.peerName=fromName;
    $('toastName').textContent=fromName;
    $('toastAvatar').textContent=fromName.charAt(0).toUpperCase();
    $('callToast').classList.add('visible');
    this._ring(true);
  }

  accept(){
    if(this.state!=='ringing') return;
    this._stopRing();
    $('callToast').classList.remove('visible');
    this.sys.socket.emit('call-response',{to:this.peerId,accept:true});
    this._setup(false);
  }

  decline(){
    if(this.state!=='ringing') return;
    this._stopRing();
    $('callToast').classList.remove('visible');
    this.sys.socket.emit('call-response',{to:this.peerId,accept:false});
    this._reset();
  }

  onResponse(from,accept){
    if(this.state!=='dialing'||from!==this.peerId) return;
    this._stopRing();
    if(!accept){
      this.sys.ui.feed(`<b>${esc(this.peerName)}</b> דחה את השיחה`);
      this.sys.ui.hideCallCard(); this._reset(); return;
    }
    this._setup(true);
  }

  _setup(initiator){
    const sys=this.sys;
    this.pc=new RTCPeerConnection({iceServers:ICE});
    // clone the mic track so call-mute doesn't silence channel PTT
    this.track=sys.localStream.getAudioTracks()[0].clone();
    this.pc.addTrack(this.track,new MediaStream([this.track]));
    this.pc.ontrack=e=>{
      try{ this.srcNode&&this.srcNode.disconnect(); }catch(err){}
      this.srcNode=sys.audioCtx.createMediaStreamSource(e.streams[0]);
      this.gain=sys.audioCtx.createGain();
      this.srcNode.connect(this.gain);
      this.gain.connect(sys.masterGain);
      const el=new Audio(); el.srcObject=e.streams[0]; el.muted=true;
      this._audioEl=el;
    };
    this.pc.onicecandidate=e=>{
      if(e.candidate) sys.socket.emit('call-signal',{to:this.peerId,signal:{type:'candidate',candidate:e.candidate}});
    };
    if(initiator){
      this.pc.createOffer({offerToReceiveAudio:true})
        .then(o=>{this.pc.setLocalDescription(o);return o;})
        .then(o=>sys.socket.emit('call-signal',{to:this.peerId,signal:{type:'offer',sdp:o}}));
    }
    this.state='active'; this.startTs=Date.now(); this.muted=false;
    sys.ui.showCallCard(this.peerName,'00:00');
    $('userDot').classList.add('busy');
    this._timer=setInterval(()=>{
      $('ccTime').textContent=fmtDur(Math.floor((Date.now()-this.startTs)/1000));
    },1000);
  }

  onSignal(from,sig){
    if(from!==this.peerId||!this.pc) return;
    if(sig.type==='offer'){
      this.pc.setRemoteDescription(new RTCSessionDescription(sig.sdp))
        .then(()=>this.pc.createAnswer())
        .then(a=>{this.pc.setLocalDescription(a);return a;})
        .then(a=>this.sys.socket.emit('call-signal',{to:this.peerId,signal:{type:'answer',sdp:a}}));
    }else if(sig.type==='answer'){
      this.pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
    }else if(sig.type==='candidate'&&sig.candidate){
      this.pc.addIceCandidate(new RTCIceCandidate(sig.candidate)).catch(()=>{});
    }
  }

  toggleMute(){
    if(this.state!=='active'||!this.track) return;
    this.muted=!this.muted;
    this.track.enabled=!this.muted;
    const b=$('ccMute');
    b.textContent=this.muted?'🎙 מושתק':'🎙 השתק';
    b.classList.toggle('muted',this.muted);
  }

  sendDTMF(digit){
    if(this.state!=='active'||!this.pc) return false;
    const sender=this.pc.getSenders().find(s=>s.track&&s.track.kind==='audio');
    if(sender&&sender.dtmf){ sender.dtmf.insertDTMF(digit); return true; }
    return false;
  }

  hangup(notify=true){
    if(this.state==='idle') return;
    this._stopRing();
    if(notify&&this.peerId) this.sys.socket.emit('call-end',{to:this.peerId});
    if(this.state==='active') this.sys.ui.feed(`שיחה עם <b>${esc(this.peerName)}</b> הסתיימה`);
    this._teardown(); this._reset();
    this.sys.ui.hideCallCard();
    $('callToast').classList.remove('visible');
    $('userDot').classList.remove('busy');
  }

  onRemoteEnd(from){
    if(from!==this.peerId) return;
    this.hangup(false);
  }

  _teardown(){
    if(this._timer){ clearInterval(this._timer); this._timer=null; }
    try{ this.pc&&this.pc.close(); }catch(e){}
    try{ this.track&&this.track.stop(); }catch(e){}
    try{ this.gain&&this.gain.disconnect(); }catch(e){}
    try{ this.srcNode&&this.srcNode.disconnect(); }catch(e){}
    this.pc=null; this.track=null; this.gain=null; this.srcNode=null;
  }

  _reset(){ this.state='idle'; this.peerId=null; this.peerName=null; }

  /* ring tone: incoming = double beep, outgoing = single long beep */
  _ring(incoming){
    const ctx=this.sys.audioCtx;
    const beep=(f,t,dur)=>{
      const o=ctx.createOscillator(), g=ctx.createGain();
      o.frequency.value=f; o.type='sine';
      g.gain.setValueAtTime(0.12,ctx.currentTime+t);
      g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+t+dur);
      o.connect(g); g.connect(this.sys.masterGain);
      o.start(ctx.currentTime+t); o.stop(ctx.currentTime+t+dur);
    };
    const pattern=()=>{
      if(incoming){ beep(880,0,.25); beep(880,.35,.25); }
      else{ beep(440,0,.8); }
    };
    pattern();
    this._ringInt=setInterval(pattern, incoming?2000:3000);
  }
  _stopRing(){ if(this._ringInt){ clearInterval(this._ringInt); this._ringInt=null; } }
}

/* ══════════════ SIP Trunk (enterprise PBX) ══════════════ */
class SIPManager {
  constructor(sys){ this.sys=sys; this.ua=null; this.registerer=null; this.session=null; this.domain=''; this.connected=false; }

  async connect(server,uri,password){
    this._status('טוען ספריית SIP...');
    await loadScript('https://cdn.jsdelivr.net/npm/sip.js@0.21.2/dist/sip.min.js');
    if(!window.SIP) throw new Error('SIP.js לא נטען');
    const sipUri=SIP.UserAgent.makeURI(uri);
    if(!sipUri) throw new Error('SIP URI לא תקין');
    this.domain=sipUri.host;
    this.ua=new SIP.UserAgent({
      uri:sipUri,
      transportOptions:{server},
      authorizationUsername:sipUri.user,
      authorizationPassword:password,
      delegate:{ onInvite:inv=>this._onInvite(inv) }
    });
    this._status('מתחבר למרכזיה...');
    await this.ua.start();
    this.registerer=new SIP.Registerer(this.ua);
    await this.registerer.register();
    this.connected=true;
    this._status('מחובר למרכזיה ✓','ok');
    this.sys.ui.feed(`<b>SIP</b> מחובר למרכזיה <span class="fc">${esc(this.domain)}</span>`);
  }

  dial(number){
    if(!this.connected) throw new Error('לא מחובר למרכזיה');
    const target=SIP.UserAgent.makeURI(`sip:${number}@${this.domain}`);
    const inviter=new SIP.Inviter(this.ua,target,{
      sessionDescriptionHandlerOptions:{constraints:{audio:true,video:false}}
    });
    this._wire(inviter);
    inviter.invite();
    this.sys.ui.feed(`<b>SIP</b> מחייג ל-<span class="fc">${esc(number)}</span>`);
  }

  _onInvite(invitation){
    this._wire(invitation);
    if(confirm(`שיחת SIP נכנסת מ-${invitation.remoteIdentity.uri.user} — לענות?`)){
      invitation.accept({sessionDescriptionHandlerOptions:{constraints:{audio:true,video:false}}});
    }else invitation.reject();
  }

  _wire(session){
    this.session=session;
    session.stateChange.addListener(state=>{
      if(state==='Established'){
        const sdh=session.sessionDescriptionHandler;
        const pc=sdh&&sdh.peerConnection;
        if(pc){
          const stream=new MediaStream();
          pc.getReceivers().forEach(r=>{ if(r.track) stream.addTrack(r.track); });
          const src=this.sys.audioCtx.createMediaStreamSource(stream);
          src.connect(this.sys.masterGain);
          this._src=src;
        }
        this._status('שיחת SIP פעילה','ok');
      }else if(state==='Terminated'){
        try{ this._src&&this._src.disconnect(); }catch(e){}
        this.session=null;
        this._status(this.connected?'מחובר למרכזיה ✓':'לא מחובר','ok');
      }
    });
  }

  sendDTMF(d){
    if(!this.session) return false;
    try{
      const sdh=this.session.sessionDescriptionHandler;
      const pc=sdh&&sdh.peerConnection;
      const sender=pc&&pc.getSenders().find(s=>s.track&&s.track.kind==='audio');
      if(sender&&sender.dtmf){ sender.dtmf.insertDTMF(d); return true; }
    }catch(e){}
    return false;
  }

  _status(msg,cls){
    const el=$('sipStatus');
    if(el){ el.innerHTML=`<span class="dot" style="${cls==='ok'?'':'background:var(--t4);box-shadow:none'}"></span> ${esc(msg)}`; el.className='sip-status'+(cls?' '+cls:''); }
  }
}

/* ══════════════ Demo Simulation ══════════════ */
class Demo {
  constructor(sys){
    this.sys=sys; this.running=false; this.timers=[];
    this.scenario=[
      {t:600,   ch:'CH-001', name:'OPS-2',     msg:'קו כללי — OPS-2 בדיקת קשר, שמיעה?'},
      {t:3400,  ch:'CH-002', name:'CTRL-1',    msg:'ועידה 1 פעילה — כל היחידות מדווחות'},
      {t:6200,  ch:'CH-004', name:'EMERGENCY', msg:'⚠️ תרגיל חירום — ערוץ 4 פעיל'},
      {t:9000,  ch:'CH-001', name:'OPS-3',     msg:'OPS-3 בקשב — יחידה מוכנה'},
      {t:11600, ch:'CH-003', name:'CTRL-2',    msg:'ועידה 2 נפתחת — ממתין לאישור'},
      {t:14200, ch:'CH-005', name:'ADMIN',     msg:'קו ניהול — עדכון לו"ז שעה 15:00'},
      {t:16800, ch:'CH-002', name:'OPS-4',     msg:'ועידה 1 — OPS-4 מוכן, עובר לשמיעה'},
      {t:19400, ch:'CH-004', name:'EMERGENCY', msg:'סיום תרגיל — חזרה לשגרה'},
      {t:22000, ch:'CH-006', name:'BROADCAST', msg:'שידור כללי — בדיקת מערכת הושלמה'},
      {t:24600, ch:'CH-001', name:'OPS-2',     msg:'קו כללי — ממתין לאישור מפקד'},
    ];
  }

  start(){
    if(this.running) return;
    this.running=true;
    for(const id of Object.keys(this.sys.channels)){
      if(!this.sys.channels[id].joined) this.sys.joinChannel(id);
    }
    this._seed();
    this._loop();
    this.sys.ui.feed('<b>סימולציה</b> הופעלה — מפעילים וירטואליים פעילים');
  }

  _seed(){
    const names=['OPS-2','OPS-3','CTRL-1','CTRL-2','ADMIN','EMERGENCY','OPS-4','BROADCAST'];
    let i=0;
    for(const ch of Object.values(this.sys.channels)){
      const n=1+Math.floor(Math.random()*2);
      for(let k=0;k<n;k++){
        const fid=`demo_${ch.id}_${k}`;
        if(!ch.peers[fid]) ch.peers[fid]={name:names[(i++)%names.length],pc:null,srcNode:null,speaking:false,audioEl:null,_demo:true};
      }
      this.sys.ui.refresh(ch.id);
    }
  }

  _loop(){
    const run=()=>{
      if(!this.running) return;
      const maxT=Math.max(...this.scenario.map(e=>e.t))+4500;
      for(const ev of this.scenario){
        this.timers.push(setTimeout(()=>{ if(this.running) this._tx(ev); },ev.t));
      }
      this.timers.push(setTimeout(run,maxT));
    };
    run();
  }

  _tx({ch,name,msg}){
    const channel=this.sys.channels[ch];
    if(!channel||!channel.joined) return;
    let pid=Object.keys(channel.peers).find(k=>channel.peers[k]._demo&&channel.peers[k].name===name)
         ||Object.keys(channel.peers).find(k=>channel.peers[k]._demo);
    if(!pid){
      pid=`demo_${ch}_x`;
      channel.peers[pid]={name,pc:null,srcNode:null,speaking:false,audioEl:null,_demo:true};
    }
    channel.peers[pid].name=name;
    channel.peers[pid].speaking=true;
    const dur=1700+msg.length*55;
    this._radio(channel,dur);
    this.sys.ui.refresh(ch);
    this.sys.ui.txLog(ch,name,msg);
    this.timers.push(setTimeout(()=>{
      if(channel.peers[pid]) channel.peers[pid].speaking=false;
      this.sys.ui.refresh(ch);
    },dur));
  }

  /* synth radio-voice noise, routed through the channel RX chain
     so volume / mute / pan / recording all apply naturally */
  _radio(channel,dur){
    channel.ensureRxChain();
    const ctx=this.sys.audioCtx;
    const frames=Math.ceil(ctx.sampleRate*dur/1000);
    const buf=ctx.createBuffer(1,frames,ctx.sampleRate);
    const d=buf.getChannelData(0);
    for(let i=0;i<frames;i++){
      const t=i/ctx.sampleRate;
      const env=.5+.5*Math.sin(2*Math.PI*2.7*t);
      d[i]=((Math.random()*2-1)*.5+Math.sin(2*Math.PI*210*t)*.3)*env*.4;
    }
    const src=ctx.createBufferSource(); src.buffer=buf;
    const hp=ctx.createBiquadFilter(); hp.type='highpass'; hp.frequency.value=300;
    const bp=ctx.createBiquadFilter(); bp.type='bandpass'; bp.frequency.value=1400; bp.Q.value=.8;
    const g=ctx.createGain(); g.gain.value=.55;
    src.connect(hp); hp.connect(bp); bp.connect(g); g.connect(channel.rxBus);
    src.start(); src.stop(ctx.currentTime+dur/1000);
  }

  stop(){
    this.running=false;
    this.timers.forEach(clearTimeout); this.timers=[];
    for(const ch of Object.values(this.sys.channels)){
      for(const id of Object.keys(ch.peers)) if(ch.peers[id]._demo) delete ch.peers[id];
      this.sys.ui.refresh(ch.id);
    }
    this.sys.ui.feed('<b>סימולציה</b> הופסקה');
  }
}

/* ══════════════ System ══════════════ */
class System {
  constructor(){
    this.socket=null; this.localStream=null;
    this.audioCtx=null; this.masterGain=null;
    this.masterVol=1; this.masterMuted=false;
    this.micAnalyser=null; this.micSrcNode=null;
    this.channels={}; this.activePTT=new Set();
    this.displayName=''; this.selfId=null;
    this.rosterList=[];
    this.voxEnabled=false; this.voxThreshold=0.08;
    this._voxActive=false; this._voxLast=0;
    this.ui=new UI(this);
    this.calls=new CallManager(this);
    this.sip=new SIPManager(this);
    this.demo=new Demo(this);
  }

  async connect(name,serverUrl){
    this.displayName=name;
    try{
      this.localStream=await navigator.mediaDevices.getUserMedia({
        audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false
      });
    }catch(e){ return 'שגיאה בגישה למיקרופון: '+e.message; }

    this.audioCtx=new (window.AudioContext||window.webkitAudioContext)();
    if(this.audioCtx.state==='suspended') await this.audioCtx.resume();
    this.masterGain=this.audioCtx.createGain();
    this.masterGain.connect(this.audioCtx.destination);

    this.micAnalyser=this.audioCtx.createAnalyser();
    this.micAnalyser.fftSize=256;
    this.micSrcNode=this.audioCtx.createMediaStreamSource(this.localStream);
    this.micSrcNode.connect(this.micAnalyser);
    this._micLoop();

    this.socket=io(serverUrl);
    try{
      await new Promise((res,rej)=>{
        this.socket.on('connect',res);
        this.socket.on('connect_error',rej);
        setTimeout(()=>rej(new Error('timeout')),8000);
      });
    }catch(e){ return 'לא ניתן להתחבר לשרת: '+serverUrl; }

    this._handlers();
    this.socket.emit('register',{name});
    return null;
  }

  _handlers(){
    const s=this.socket;
    s.on('init',({channels,roster,selfId})=>{
      this.selfId=selfId;
      channels.forEach(c=>this.addChannel(c.id,c.name,false));
      this.rosterList=roster;
      this.ui.renderRoster();
    });
    s.on('roster',r=>{ this.rosterList=r; this.ui.renderRoster(); });
    s.on('channel-created',c=>this.addChannel(c.id,c.name,false));
    s.on('activity',a=>this.ui.activityEvent(a));

    s.on('channel-peers',({channelId,peers})=>{
      const ch=this.channels[channelId]; if(!ch) return;
      peers.forEach(p=>ch.addPeer(p.id,p.name,true));
      this.ui.refresh(channelId);
    });
    s.on('peer-joined',({channelId,peerId,name})=>{
      const ch=this.channels[channelId]; if(!ch) return;
      ch.addPeer(peerId,name,false); this.ui.refresh(channelId);
    });
    s.on('peer-left',({channelId,peerId})=>{
      const ch=this.channels[channelId]; if(!ch) return;
      ch.removePeer(peerId); this.ui.refresh(channelId);
    });
    s.on('signal',({from,channelId,signal})=>{
      const ch=this.channels[channelId];
      if(ch&&ch.joined) ch.handleSignal(from,signal);
    });
    s.on('ptt-start',({peerId,channelId})=>{
      const ch=this.channels[channelId]; if(!ch) return;
      if(ch.peers[peerId]) ch.peers[peerId].speaking=true;
      this.ui.refresh(channelId);
    });
    s.on('ptt-stop',({peerId,channelId})=>{
      const ch=this.channels[channelId]; if(!ch) return;
      if(ch.peers[peerId]) ch.peers[peerId].speaking=false;
      this.ui.refresh(channelId);
    });

    // private calls
    s.on('incoming-call',({from,fromName})=>this.calls.onIncoming(from,fromName));
    s.on('call-response',({from,accept})=>this.calls.onResponse(from,accept));
    s.on('call-signal',({from,signal})=>this.calls.onSignal(from,signal));
    s.on('call-end',({from})=>this.calls.onRemoteEnd(from));
  }

  addChannel(id,name,announce=true){
    if(this.channels[id]) return;
    this.channels[id]=new Channel(id,name||id,this);
    this.ui.renderCard(id);
    this.ui.stats();
    if(announce) this.socket.emit('create-channel',{id,name});
  }

  joinChannel(id){
    const ch=this.channels[id]; if(!ch||ch.joined) return;
    ch.joined=true;
    this.socket.emit('join-channel',{channelId:id,displayName:this.displayName});
    this.ui.refresh(id); this.ui.stats();
  }
  leaveChannel(id){
    const ch=this.channels[id]; if(!ch||!ch.joined) return;
    this.stopPTT(id); ch.cleanup(); ch.joined=false;
    this.socket.emit('leave-channel',{channelId:id});
    this.ui.refresh(id); this.ui.stats();
  }

  startPTT(id){
    const ch=this.channels[id];
    if(!ch||!ch.joined||this.activePTT.has(id)) return;
    this.activePTT.add(id); ch.setTX(true);
    this.socket.emit('ptt-start',{channelId:id});
    this.ui.refresh(id);
  }
  stopPTT(id){
    if(!this.activePTT.has(id)) return;
    this.activePTT.delete(id);
    const ch=this.channels[id];
    if(ch){ ch.setTX(false); this.socket.emit('ptt-stop',{channelId:id}); this.ui.refresh(id); }
  }
  startPTTAll(){
    Object.keys(this.channels).forEach(id=>{ if(this.channels[id].joined) this.startPTT(id); });
    $('pttAllBtn').classList.add('active');
  }
  stopPTTAll(){
    Object.keys(this.channels).forEach(id=>this.stopPTT(id));
    $('pttAllBtn').classList.remove('active');
  }

  setMasterVol(v){
    this.masterVol=v;
    if(this.masterGain) this.masterGain.gain.value=this.masterMuted?0:v;
    $('mvVal').textContent=Math.round(v*100)+'%';
  }
  toggleMasterMute(){
    this.masterMuted=!this.masterMuted;
    if(this.masterGain) this.masterGain.gain.value=this.masterMuted?0:this.masterVol;
    const b=$('muteAllBtn');
    b.textContent=this.masterMuted?'🔇 בטל השתקה':'🔊 השתק הכל';
    b.classList.toggle('on',this.masterMuted);
  }

  /* mic VU + VOX detection loop */
  _micLoop(){
    const tick=()=>{
      if(this.micAnalyser){
        const d=new Uint8Array(this.micAnalyser.frequencyBinCount);
        this.micAnalyser.getByteFrequencyData(d);
        const lvl=d.reduce((s,x)=>s+x,0)/d.length/128;
        const show=(this.activePTT.size>0||this.voxEnabled)?Math.min(lvl*110,100):0;
        const el=$('micVU'); if(el) el.style.width=show+'%';

        if(this.voxEnabled){
          const now=Date.now();
          if(lvl>this.voxThreshold){
            this._voxLast=now;
            if(!this._voxActive){ this._voxActive=true; this.startPTTAll(); }
          }else if(this._voxActive&&now-this._voxLast>700){
            this._voxActive=false; this.stopPTTAll();
          }
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  toggleVox(){
    this.voxEnabled=!this.voxEnabled;
    if(!this.voxEnabled&&this._voxActive){ this._voxActive=false; this.stopPTTAll(); }
    $('voxBtn').classList.toggle('on',this.voxEnabled);
    this.ui.feed(`<b>VOX</b> ${this.voxEnabled?'הופעל — דיבור משדר אוטומטית':'כובה'}`);
  }

  async setMicDevice(deviceId){
    try{
      const stream=await navigator.mediaDevices.getUserMedia({
        audio:{deviceId:{exact:deviceId},echoCancellation:true,noiseSuppression:true},video:false
      });
      this.localStream.getTracks().forEach(t=>t.stop());
      this.localStream=stream;
      try{ this.micSrcNode.disconnect(); }catch(e){}
      this.micSrcNode=this.audioCtx.createMediaStreamSource(stream);
      this.micSrcNode.connect(this.micAnalyser);
      Object.values(this.channels).forEach(ch=>ch.rewireMic());
      this.ui.feed('<b>מיקרופון</b> הוחלף בהצלחה');
    }catch(e){ alert('שגיאה בהחלפת מיקרופון: '+e.message); }
  }

  async setSpeakerDevice(deviceId){
    try{
      if(this.audioCtx.setSinkId){ await this.audioCtx.setSinkId(deviceId); this.ui.feed('<b>התקן השמעה</b> הוחלף'); }
      else alert('הדפדפן לא תומך בבחירת התקן השמעה (נסה Chrome עדכני)');
    }catch(e){ alert('שגיאה: '+e.message); }
  }

  /* DTMF tone (audible feedback, and real RFC tones when in a call) */
  playDTMF(d){
    const f=DTMF_FREQS[d]; if(!f) return;
    const ctx=this.audioCtx, t=ctx.currentTime;
    f.forEach(freq=>{
      const o=ctx.createOscillator(), g=ctx.createGain();
      o.frequency.value=freq;
      g.gain.setValueAtTime(.08,t);
      g.gain.exponentialRampToValueAtTime(.001,t+.18);
      o.connect(g); g.connect(this.masterGain);
      o.start(t); o.stop(t+.18);
    });
    this.calls.sendDTMF(d)||this.sip.sendDTMF(d);
  }
}

/* ══════════════ UI ══════════════ */
class UI {
  constructor(sys){ this.sys=sys; }

  showApp(){
    $('loginScreen').classList.add('hidden');
    $('app').classList.add('active');
    $('hdrName').textContent=this.sys.displayName;
    this._clock(); this._keys(); this._keypad();
  }

  /* ── channel cards ── */
  renderCard(id){
    const g=$('grid'); if(!g) return;
    const d=document.createElement('div');
    d.id='wrap-'+id;
    d.innerHTML=this._cardHTML(id);
    g.appendChild(d);
  }

  refresh(id){
    const w=$('wrap-'+id); if(!w) return;
    const logEl=$('log-'+id);
    const atBottom=logEl?(logEl.scrollHeight-logEl.scrollTop-logEl.clientHeight<12):true;
    const st=logEl?logEl.scrollTop:0;
    w.innerHTML=this._cardHTML(id);
    const nl=$('log-'+id);
    if(nl) nl.scrollTop=atBottom?nl.scrollHeight:st;
    this.stats();
  }

  _cardHTML(id){
    const sys=this.sys, ch=sys.channels[id];
    const isTX=sys.activePTT.has(id), isRX=ch.isRX(), isREC=!!ch.recorder;
    const idx=Object.keys(sys.channels).indexOf(id);
    const peers=Object.values(ch.peers);
    const cls=['card',ch.joined?'joined':'',isRX?'rx':'',isTX?'tx':''].filter(Boolean).join(' ');

    const peerHtml=ch.joined
      ?(peers.length
        ?peers.map(p=>`<div class="peer-tag${p.speaking?' spk':''}"><span class="pdot"></span>${esc(p.name)}</div>`).join('')
        :'<span class="no-peer">ממתין למשתתפים...</span>')
      :'<span class="no-peer">לא מחובר לערוץ</span>';

    const logHtml=ch.log.length
      ?ch.log.slice(-8).map(e=>`<div class="tx-entry"><span class="tx-who">${esc(e.name)}</span><span class="tx-text">${esc(e.msg)}</span></div>`).join('')
      :'<span class="tx-empty">אין שידורים</span>';

    const panPct=Math.round(ch.pan*100);
    const panLabel=panPct===0?'C':(panPct<0?`L${-panPct}`:`R${panPct}`);

    return `<div class="${cls}">
  <div class="card-accent"></div>
  <div class="card-hdr">
    <div class="ch-info">
      <div class="ch-id-row">
        <span class="ch-id">${esc(id)}</span>
        ${idx<9?`<span class="hotkey">${idx+1}</span>`:''}
      </div>
      <div class="ch-name">${esc(ch.name)}</div>
      <div class="indics">
        <span class="indic i-rx${isRX?' on':''}">RX</span>
        <span class="indic i-tx${isTX?' on':''}">TX</span>
        <span class="indic i-rec${isREC?' on':''}">REC</span>
      </div>
    </div>
    ${ch.joined
      ?`<button class="join-btn leave" onclick="APP.leave('${id}')">עזוב</button>`
      :`<button class="join-btn" onclick="APP.join('${id}')">הצטרף</button>`}
  </div>
  <div class="card-body">
    <div class="peers">${peerHtml}</div>
    <div class="vu"><div class="vu-fill" id="vu-${id}"></div></div>
    <div class="mix-row">
      <span class="mix-icon" onclick="APP.toggleMute('${id}')">${ch.muted?'🔇':'🔊'}</span>
      <input type="range" min="0" max="1" step="0.01" value="${ch.volume}" ${!ch.joined?'disabled':''}
        oninput="APP.setVol('${id}',+this.value);document.getElementById('vv-${id}').textContent=Math.round(this.value*100)+'%'">
      <span class="mix-val" id="vv-${id}">${Math.round(ch.volume*100)}%</span>
    </div>
    <div class="mix-row">
      <span class="mix-label">PAN</span>
      <input type="range" min="-1" max="1" step="0.05" value="${ch.pan}" ${!ch.joined?'disabled':''}
        oninput="APP.setPan('${id}',+this.value)" ondblclick="this.value=0;APP.setPan('${id}',0)">
      <span class="pan-val" id="pp-${id}">${panLabel}</span>
    </div>
    <div class="tools-row">
      <button class="tool-btn ${ch.muted?'muted':''}" ${!ch.joined?'disabled':''} onclick="APP.toggleMute('${id}')">${ch.muted?'בטל השתקה':'השתק'}</button>
      <button class="tool-btn ${isREC?'rec-on':''}" ${!ch.joined?'disabled':''} onclick="APP.toggleRec('${id}')">${isREC?'● עצור':'● הקלט'}</button>
      <span class="pcount">${peers.length}👤</span>
    </div>
    <button class="ptt${isTX?' active':''}" ${!ch.joined?'disabled':''}
      onmousedown="APP.pttStart('${id}',event)" onmouseup="APP.pttStop('${id}')"
      ontouchstart="APP.pttStart('${id}',event)" ontouchend="APP.pttStop('${id}')"
      onmouseleave="APP.pttStop('${id}')">
      <span>${isTX?'🔴':'📡'}</span><span>${isTX?'TX — שידור פעיל':'PTT — לחץ לשידור'}</span>
    </button>
  </div>
  <div class="tx-log" id="log-${id}">${logHtml}</div>
</div>`;
  }

  txLog(channelId,name,msg){
    const ch=this.sys.channels[channelId]; if(!ch) return;
    ch.log.push({name,msg}); if(ch.log.length>50) ch.log.shift();
    const log=$('log-'+channelId); if(!log) return;
    const empty=log.querySelector('.tx-empty'); if(empty) empty.remove();
    const d=document.createElement('div');
    d.className='tx-entry';
    d.innerHTML=`<span class="tx-who">${esc(name)}</span><span class="tx-text">${esc(msg)}</span>`;
    log.appendChild(d); log.scrollTop=log.scrollHeight;
  }

  /* ── roster ── */
  renderRoster(){
    const sys=this.sys, el=$('roster'); if(!el) return;
    $('rosterCount').textContent=sys.rosterList.length;
    el.innerHTML=sys.rosterList.map(u=>{
      const me=u.id===sys.selfId;
      return `<div class="r-item">
        <span class="dot" style="width:6px;height:6px"></span>
        <span class="r-name">${esc(u.name)}</span>
        ${me?'<span class="r-you">אתה</span>'
            :`<button class="r-call" title="שיחה פרטית" onclick="APP.callUser('${u.id}','${esc(u.name)}')">📞</button>`}
      </div>`;
    }).join('');
  }

  /* ── activity feed ── */
  feed(html){
    const el=$('feed'); if(!el) return;
    const d=document.createElement('div');
    d.className='feed-item';
    d.innerHTML=`<span class="feed-time">${fmtClock(new Date())}</span><span>${html}</span>`;
    el.prepend(d);
    while(el.children.length>40) el.removeChild(el.lastChild);
  }

  activityEvent(a){
    const map={
      'user-online':   ()=>`<b>${esc(a.name)}</b> התחבר למערכת`,
      'user-offline':  ()=>`<b>${esc(a.name)}</b> התנתק`,
      'channel-joined':()=>`<b>${esc(a.name)}</b> הצטרף ל-<span class="fc">${esc(a.channel)}</span>`,
      'channel-left':  ()=>`<b>${esc(a.name)}</b> עזב את <span class="fc">${esc(a.channel)}</span>`,
      'channel-created':()=>`ערוץ חדש <span class="fc">${esc(a.channel)}</span> נוצר`,
      'call-started':  ()=>`שיחה פרטית: <b>${esc(a.name)}</b> ↔ <b>${esc(a.peer||'')}</b>`,
    };
    const fn=map[a.type];
    if(fn) this.feed(fn());
  }

  /* ── call card ── */
  showCallCard(name,timeText){
    $('ccName').textContent=name;
    $('ccTime').textContent=timeText;
    $('ccAvatar').textContent=name.charAt(0).toUpperCase();
    const b=$('ccMute'); b.textContent='🎙 השתק'; b.classList.remove('muted');
    $('callCard').classList.add('visible');
  }
  hideCallCard(){ $('callCard').classList.remove('visible'); }

  stats(){
    const sys=this.sys;
    const joined=Object.values(sys.channels).filter(c=>c.joined).length;
    const total=Object.keys(sys.channels).length;
    $('mhStats').textContent=`${joined}/${total} פעילים`;
  }

  _clock(){
    const tick=()=>{ $('clock').textContent=fmtClock(new Date()); };
    tick(); setInterval(tick,1000);
  }

  _keys(){
    document.addEventListener('keydown',e=>{
      if(e.repeat||['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
      if(e.code==='Space'){ e.preventDefault(); APP.pttAllStart(e); return; }
      const n=parseInt(e.key);
      if(n>=1&&n<=9){
        const ids=Object.keys(this.sys.channels);
        if(ids[n-1]) APP.pttStart(ids[n-1]);
      }
    });
    document.addEventListener('keyup',e=>{
      if(['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
      if(e.code==='Space'){ APP.pttAllStop(); return; }
      const n=parseInt(e.key);
      if(n>=1&&n<=9){
        const ids=Object.keys(this.sys.channels);
        if(ids[n-1]) APP.pttStop(ids[n-1]);
      }
    });
  }

  _keypad(){
    const kp=$('keypad'); if(!kp) return;
    kp.innerHTML=DTMF_KEYS.map(k=>`<button class="key" onclick="APP.dialKey('${k}')">${k}</button>`).join('');
  }
}

/* ══════════════ App Controller ══════════════ */
const APP={
  sys:new System(),
  _demoOn:false,
  _dialNum:'',

  async connect(){
    const name=$('inName').value.trim()||'OPS-'+Math.floor(Math.random()*900+100);
    const server=$('inServer').value.trim()||window.location.origin;
    const btn=$('connectBtn'), err=$('loginErr');
    err.textContent=''; btn.disabled=true; btn.textContent='מתחבר...';
    const e=await this.sys.connect(name,server);
    if(e){ err.textContent=e; btn.disabled=false; btn.textContent='התחבר למערכת'; return; }
    this.sys.ui.showApp();
  },

  join(id){ this.sys.joinChannel(id); },
  leave(id){ this.sys.leaveChannel(id); },
  pttStart(id,e){ if(e){e.preventDefault();e.stopPropagation();} this.sys.startPTT(id); },
  pttStop(id){ this.sys.stopPTT(id); },
  pttAllStart(e){ if(e&&e.preventDefault)e.preventDefault(); this.sys.startPTTAll(); },
  pttAllStop(){ this.sys.stopPTTAll(); },

  setVol(id,v){ const ch=this.sys.channels[id]; if(ch){ ch.volume=v; ch.applyMix(); } },
  setPan(id,v){
    const ch=this.sys.channels[id];
    if(ch){
      ch.pan=v; ch.applyMix();
      const p=Math.round(v*100);
      const el=$('pp-'+id); if(el) el.textContent=p===0?'C':(p<0?`L${-p}`:`R${p}`);
    }
  },
  toggleMute(id){
    const ch=this.sys.channels[id];
    if(ch){ ch.muted=!ch.muted; ch.applyMix(); this.sys.ui.refresh(id); }
  },
  toggleRec(id){
    const ch=this.sys.channels[id]; if(!ch) return;
    ch.recorder?ch.stopRecording():ch.startRecording();
    this.sys.ui.refresh(id);
  },

  masterVol(v){ this.sys.setMasterVol(v); },
  toggleMasterMute(){ this.sys.toggleMasterMute(); },
  toggleVox(){ this.sys.toggleVox(); },
  setVoxThreshold(v){ this.sys.voxThreshold=v; $('voxThVal').textContent=v.toFixed(2); },

  /* channels */
  toggleAddRow(){ $('addRow').classList.toggle('open'); },
  addChannel(){
    const id=$('newChId').value.trim().toUpperCase();
    const name=$('newChName').value.trim();
    if(!id) return;
    if(this.sys.channels[id]){ alert('ערוץ '+id+' כבר קיים'); return; }
    this.sys.addChannel(id,name||id,true);
    $('addRow').classList.remove('open');
    $('newChId').value=''; $('newChName').value='';
  },

  /* private calls */
  callUser(id,name){ this.sys.calls.call(id,name); },
  callAccept(){ this.sys.calls.accept(); },
  callDecline(){ this.sys.calls.decline(); },
  callMute(){ this.sys.calls.toggleMute(); },
  callHangup(){ this.sys.calls.hangup(); },

  /* dialer / SIP */
  openDialer(){ $('dialerOverlay').classList.add('open'); },
  openSettings(){ this._loadDevices(); $('settingsOverlay').classList.add('open'); },
  closeModal(id){ $(id).classList.remove('open'); },

  dialKey(k){
    this._dialNum+=k;
    $('dialDisplay').textContent=this._dialNum;
    this.sys.playDTMF(k);
  },
  dialDel(){
    this._dialNum=this._dialNum.slice(0,-1);
    $('dialDisplay').innerHTML=this._dialNum||'&nbsp;';
  },
  dialCall(){
    if(!this._dialNum) return;
    try{ this.sys.sip.dial(this._dialNum); }
    catch(e){ alert(e.message+'\nהתחבר קודם למרכזיה (SIP) בחלק התחתון של החייגן.'); }
  },
  async sipConnect(){
    const server=$('sipServer').value.trim();
    const uri=$('sipUri').value.trim();
    const pass=$('sipPass').value;
    if(!server||!uri){ alert('נא למלא כתובת שרת ו-SIP URI'); return; }
    const btn=$('sipConnectBtn'); btn.disabled=true;
    try{ await this.sys.sip.connect(server,uri,pass); }
    catch(e){
      const el=$('sipStatus');
      el.className='sip-status err';
      el.innerHTML=`<span class="dot" style="background:var(--red)"></span> שגיאה: ${esc(e.message)}`;
    }
    btn.disabled=false;
  },

  async _loadDevices(){
    try{
      const devs=await navigator.mediaDevices.enumerateDevices();
      const mics=devs.filter(d=>d.kind==='audioinput');
      const spks=devs.filter(d=>d.kind==='audiooutput');
      $('micSelect').innerHTML=mics.map(d=>`<option value="${d.deviceId}">${esc(d.label||'מיקרופון')}</option>`).join('');
      $('spkSelect').innerHTML=spks.length
        ?spks.map(d=>`<option value="${d.deviceId}">${esc(d.label||'רמקול')}</option>`).join('')
        :'<option>ברירת מחדל</option>';
    }catch(e){}
  },
  setMic(id){ this.sys.setMicDevice(id); },
  setSpeaker(id){ this.sys.setSpeakerDevice(id); },

  /* demo */
  demoClick(){
    if(this._demoOn){ this.stopDemo(); return; }
    $('demoOverlay').classList.add('open');
  },
  startDemo(){
    this.closeModal('demoOverlay');
    this._demoOn=true;
    this.sys.demo.start();
    const b=$('demoBtn'); b.textContent='■ עצור סימולציה'; b.classList.add('running');
    $('demoBadge').classList.add('visible');
  },
  stopDemo(){
    this._demoOn=false;
    this.sys.demo.stop();
    const b=$('demoBtn'); b.textContent='▶ סימולציה'; b.classList.remove('running');
    $('demoBadge').classList.remove('visible');
  },

  disconnect(){
    if(!confirm('להתנתק מהמערכת?')) return;
    if(this._demoOn) this.sys.demo.stop();
    this.sys.calls.hangup();
    Object.keys(this.sys.channels).forEach(id=>{
      if(this.sys.channels[id].joined) this.sys.leaveChannel(id);
    });
    if(this.sys.socket) this.sys.socket.disconnect();
    location.reload();
  }
};

/* ── init ── */
$('inServer').value=window.location.origin;
document.addEventListener('contextmenu',e=>{
  if(e.target.closest('.ptt,.ptt-all')) e.preventDefault();
});
