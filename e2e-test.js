const { io } = require('socket.io-client');
const a = io('http://localhost:3000'), b = io('http://localhost:3000');
let pass = 0;
const done = () => { console.log(`PASSED ${pass} checks`); process.exit(0); };

a.on('connect', () => a.emit('register', { name: 'ALPHA' }));
b.on('connect', () => b.emit('register', { name: 'BRAVO' }));

a.on('init', d => { if (d.channels.length === 6 && d.selfId) { pass++; console.log('init ok'); } });

let rosterSeen = false;
b.on('roster', r => {
  if (r.length === 2 && !rosterSeen) {
    rosterSeen = true; pass++; console.log('roster ok');
    a.emit('join-channel', { channelId: 'CH-001', displayName: 'ALPHA' });
    setTimeout(() => b.emit('join-channel', { channelId: 'CH-001', displayName: 'BRAVO' }), 200);
  }
});

b.on('channel-peers', d => { if (d.peers.length === 1 && d.peers[0].name === 'ALPHA') { pass++; console.log('channel-peers ok'); } });
a.on('peer-joined', d => {
  pass++; console.log('peer-joined ok');
  a.emit('signal', { to: d.peerId, channelId: 'CH-001', signal: { type: 'offer', sdp: 'test' } });
  a.emit('ptt-start', { channelId: 'CH-001' });
});
b.on('signal', d => { if (d.signal.type === 'offer') { pass++; console.log('signal relay ok'); } });
b.on('ptt-start', d => {
  pass++; console.log('ptt relay ok');
  b.emit('call-user', { to: d.peerId });
});
a.on('incoming-call', d => {
  pass++; console.log('incoming-call ok');
  a.emit('call-response', { to: d.from, accept: true });
});
b.on('call-response', d => { if (d.accept) { pass++; console.log('call-response ok'); done(); } });

setTimeout(() => { console.log('TIMEOUT, passed', pass); process.exit(1); }, 6000);
