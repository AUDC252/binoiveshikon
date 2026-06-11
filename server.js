const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, 'public')));

// ── State ────────────────────────────────────────────────────
// Online users roster: socketId -> { name, status }
const users = {};

// Server-managed channel definitions, shared with every client
const channelDefs = [
  { id: 'CH-001', name: 'קו כללי',     color: 'blue'   },
  { id: 'CH-002', name: 'ועידה 1',     color: 'violet' },
  { id: 'CH-003', name: 'ועידה 2',     color: 'violet' },
  { id: 'CH-004', name: 'חירום',       color: 'red'    },
  { id: 'CH-005', name: 'קו ניהול',    color: 'green'  },
  { id: 'CH-006', name: 'שידור כללי',  color: 'amber'  },
];

// Channel membership: channelId -> Map<socketId, { name }>
const channels = {};
// socketId -> Set<channelId>
const socketChannels = {};

function getChannel(channelId) {
  if (!channels[channelId]) channels[channelId] = new Map();
  return channels[channelId];
}

function roster() {
  return Object.entries(users).map(([id, u]) => ({ id, name: u.name }));
}

function activity(type, data) {
  io.emit('activity', { type, ...data, ts: Date.now() });
}

// ── Socket handlers ──────────────────────────────────────────
io.on('connection', (socket) => {
  socketChannels[socket.id] = new Set();

  socket.on('register', ({ name }) => {
    users[socket.id] = { name };
    socket.emit('init', { channels: channelDefs, roster: roster(), selfId: socket.id });
    io.emit('roster', roster());
    activity('user-online', { name });
    console.log(`[+] ${name} (${socket.id})`);
  });

  socket.on('create-channel', ({ id, name }) => {
    if (channelDefs.some(c => c.id === id)) return;
    const def = { id, name: name || id, color: 'blue' };
    channelDefs.push(def);
    io.emit('channel-created', def);
    activity('channel-created', { channel: id, name: users[socket.id]?.name });
  });

  // ── Channels ──
  socket.on('join-channel', ({ channelId, displayName }) => {
    const ch = getChannel(channelId);
    const existingPeers = [...ch.entries()].map(([id, d]) => ({ id, name: d.name }));
    ch.set(socket.id, { name: displayName });
    socketChannels[socket.id].add(channelId);
    socket.join(channelId);
    socket.emit('channel-peers', { channelId, peers: existingPeers });
    socket.to(channelId).emit('peer-joined', { channelId, peerId: socket.id, name: displayName });
    activity('channel-joined', { channel: channelId, name: displayName });
  });

  socket.on('leave-channel', ({ channelId }) => doLeave(socket, channelId, true));

  socket.on('signal', ({ to, channelId, signal }) => {
    socket.to(to).emit('signal', { from: socket.id, channelId, signal });
  });

  socket.on('ptt-start', ({ channelId }) => {
    socket.to(channelId).emit('ptt-start', { peerId: socket.id, channelId });
  });
  socket.on('ptt-stop', ({ channelId }) => {
    socket.to(channelId).emit('ptt-stop', { peerId: socket.id, channelId });
  });

  socket.on('chat', ({ channelId, text, name }) => {
    io.to(channelId).emit('chat', { channelId, text, name, ts: Date.now() });
  });

  // ── Private calls ──
  socket.on('call-user', ({ to }) => {
    socket.to(to).emit('incoming-call', { from: socket.id, fromName: users[socket.id]?.name || '?' });
  });
  socket.on('call-response', ({ to, accept }) => {
    socket.to(to).emit('call-response', { from: socket.id, accept });
    if (accept) activity('call-started', { name: users[socket.id]?.name, peer: users[to]?.name });
  });
  socket.on('call-signal', ({ to, signal }) => {
    socket.to(to).emit('call-signal', { from: socket.id, signal });
  });
  socket.on('call-end', ({ to }) => {
    socket.to(to).emit('call-end', { from: socket.id });
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    const name = users[socket.id]?.name;
    for (const channelId of [...(socketChannels[socket.id] || [])]) {
      doLeave(socket, channelId, false);
    }
    delete socketChannels[socket.id];
    delete users[socket.id];
    io.emit('roster', roster());
    if (name) activity('user-offline', { name });
    console.log(`[-] ${name || socket.id}`);
  });

  function doLeave(socket, channelId, announce) {
    const ch = channels[channelId];
    if (!ch || !ch.has(socket.id)) return;
    const name = ch.get(socket.id)?.name;
    ch.delete(socket.id);
    if (ch.size === 0) delete channels[channelId];
    socketChannels[socket.id]?.delete(channelId);
    socket.leave(channelId);
    socket.to(channelId).emit('peer-left', { channelId, peerId: socket.id });
    if (announce) activity('channel-left', { channel: channelId, name });
  }
});

// ── REST ─────────────────────────────────────────────────────
app.get('/api/channels', (req, res) => {
  res.json(channelDefs.map(def => ({
    ...def,
    count: channels[def.id]?.size || 0,
    users: [...(channels[def.id]?.values() || [])].map(u => u.name)
  })));
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`AUDC VoIP Server → http://localhost:${PORT}`);
});
