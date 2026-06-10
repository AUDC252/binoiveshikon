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

// Channel state: channelId -> Map<socketId, { name }>
const channels = {};
// Socket -> Set of joined channelIds
const socketChannels = {};

function getChannel(channelId) {
  if (!channels[channelId]) channels[channelId] = new Map();
  return channels[channelId];
}

io.on('connection', (socket) => {
  console.log(`[+] ${socket.id} connected`);
  socketChannels[socket.id] = new Set();

  socket.on('join-channel', ({ channelId, displayName }) => {
    const ch = getChannel(channelId);
    const existingPeers = [...ch.entries()].map(([id, d]) => ({ id, name: d.name }));

    ch.set(socket.id, { name: displayName });
    socketChannels[socket.id].add(channelId);
    socket.join(channelId);

    socket.emit('channel-peers', { channelId, peers: existingPeers });
    socket.to(channelId).emit('peer-joined', { channelId, peerId: socket.id, name: displayName });

    console.log(`[CH:${channelId}] ${displayName} joined (${ch.size} total)`);
  });

  socket.on('leave-channel', ({ channelId }) => {
    doLeave(socket, channelId);
  });

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

  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id} disconnected`);
    for (const channelId of [...(socketChannels[socket.id] || [])]) {
      doLeave(socket, channelId);
    }
    delete socketChannels[socket.id];
  });

  function doLeave(socket, channelId) {
    const ch = channels[channelId];
    if (!ch) return;
    ch.delete(socket.id);
    if (ch.size === 0) delete channels[channelId];
    socketChannels[socket.id]?.delete(channelId);
    socket.leave(channelId);
    socket.to(channelId).emit('peer-left', { channelId, peerId: socket.id });
    console.log(`[CH:${channelId}] ${socket.id} left`);
  }
});

app.get('/api/channels', (req, res) => {
  const result = Object.entries(channels).map(([id, ch]) => ({
    id,
    count: ch.size,
    users: [...ch.values()].map(u => u.name)
  }));
  res.json(result);
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`AUDC VoIP Server → http://localhost:${PORT}`);
});
