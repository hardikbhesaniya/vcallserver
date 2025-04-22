const express = require('express');
const http = require('http');
const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);

// Waiting queue for users
let waitingQueue = [];
// Active rooms
let rooms = {};   
// Track user socket IDs to handle reconnections properly
let userSocketMap = {};
// Track users that have connected before (to prevent rejoining)
let connectedUsers = new Set();

// Generate random room ID
function generateRoomId() {
  return Math.random().toString(36).substring(2, 15);
}

// Get current counts
function getCounts() {
  return {
    users: Object.keys(userSocketMap).length,
    rooms: Object.keys(rooms).length,
    queue: waitingQueue.length
  };
}

// Get current timestamp for logging
function getTimestamp() {
  return new Date().toISOString();
}

// Clean up function to remove a user from all states
function cleanupUser(userId, socketId) {
  waitingQueue = waitingQueue.filter(user => user.userId !== userId && user.socketId !== socketId);

  let roomsToDelete = [];
  for (const roomId in rooms) {
    const room = rooms[roomId];
    const userInRoom = room.users.some(user => user.userId === userId || user.socketId === socketId);

    if (userInRoom) {
      roomsToDelete.push(roomId);
      for (const user of room.users) {
        if (user.userId !== userId && user.socketId !== socketId) {
          io.to(user.socketId).emit('user_disconnected');
        }
      }
    }
  }

  roomsToDelete.forEach(roomId => delete rooms[roomId]);
  if (userSocketMap[userId] === socketId) delete userSocketMap[userId];
}

io.on('connection', (socket) => {
  console.log(`[${getTimestamp()}] CONNECT: Socket ${socket.id} connected.`);

  socket.on('join_queue', (data) => {
    console.log(`Join_Queue : ${data.userId}`);
    const userId = data.userId;

    // Check if this user has connected before, and reject if so
    if (connectedUsers.has(userId)) {
      socket.emit('join_rejected', {
        message: 'User ID has already been used in a previous session'
      });
      console.log(`[${getTimestamp()}] QUEUE_REJECTED: User ${userId} (socket ${socket.id}) rejected - previously connected`);
      return;
    }

    // Add to the set of connected users
    connectedUsers.add(userId);

    cleanupUser(userId, socket.id);
    waitingQueue.push({ socketId: socket.id, userId });
    userSocketMap[userId] = socket.id;

    const counts = getCounts();
    console.log(`[${getTimestamp()}] QUEUE_JOIN: User ${userId} (socket ${socket.id}) joined queue. Users: ${counts.users}, Rooms: ${counts.rooms}, Queue: ${counts.queue}`);
    matchUsers();
  });

  socket.on('offer', (data) => io.to(data.roomId).emit('offer', data));
  socket.on('answer', (data) => io.to(data.roomId).emit('answer', data));
  socket.on('ice_candidate', (data) => io.to(data.roomId).emit('ice_candidate', data));

  socket.on('skip', (data) => {
    const roomId = data.roomId;
    const userId = data.userId;

    if (rooms[roomId]) {
      const otherUserSocketId = rooms[roomId].users.find(u => u.userId !== userId)?.socketId;
      if (otherUserSocketId) io.to(otherUserSocketId).emit('user_disconnected');
      delete rooms[roomId];
      console.log(`[${getTimestamp()}] ROOM_SKIPPED: Room ${roomId} skipped by user ${userId}`);
    }

    waitingQueue.push({ socketId: socket.id, userId });
    const counts = getCounts();
    console.log(`[${getTimestamp()}] USER_REQUEUED: User ${userId} (socket ${socket.id}) re-queued after skip. Users: ${counts.users}, Rooms: ${counts.rooms}, Queue: ${counts.queue}`);
    matchUsers();
  });

  socket.on('leave_room', (data, callback) => {
    const roomId = data.roomId;
    const userId = data.userId;

    if (!rooms[roomId]) {
      socket.emit('fully_disconnected');
      if (callback) callback({ success: true });
      console.log(`[${getTimestamp()}] LEAVE_ROOM: Room ${roomId} already empty when user ${userId} tried to leave`);
      return;
    }

    const roomUsers = rooms[roomId].users;
    roomUsers.forEach(user => {
      if (user.userId !== userId) {
        io.to(user.socketId).emit('user_disconnected');
        const userSocket = io.sockets.sockets.get(user.socketId);
        if (userSocket) userSocket.leave(roomId);
      }
    });

    socket.leave(roomId);
    delete rooms[roomId];
    waitingQueue = waitingQueue.filter(user => user.userId !== userId);
    socket.emit('fully_disconnected');

    const counts = getCounts();
    console.log(`[${getTimestamp()}] ROOM_LEFT: User ${userId} left room ${roomId}. Users: ${counts.users}, Rooms: ${counts.rooms}, Queue: ${counts.queue}`);
    if (callback) callback({ success: true });
  });

  socket.on('disconnect', () => {
    let disconnectedUserId = null;
    for (const [userId, socketId] of Object.entries(userSocketMap)) {
      if (socketId === socket.id) {
        disconnectedUserId = userId;
        break;
      }
    }

    if (disconnectedUserId) {
      cleanupUser(disconnectedUserId, socket.id);
    } else {
      waitingQueue = waitingQueue.filter(user => user.socketId !== socket.id);
      for (const roomId in rooms) {
        const room = rooms[roomId];
        const userIndex = room.users.findIndex(user => user.socketId === socket.id);
        if (userIndex !== -1) {
          room.users.forEach(user => {
            if (user.socketId !== socket.id) io.to(user.socketId).emit('user_disconnected');
          });
          delete rooms[roomId];
        }
      }
    }

    const counts = getCounts();
    console.log(`[${getTimestamp()}] DISCONNECT: Socket ${socket.id} (user ${disconnectedUserId || 'unknown'}) disconnected. Users: ${counts.users}, Rooms: ${counts.rooms}, Queue: ${counts.queue}`);
  });
});

function matchUsers() {
  while (waitingQueue.length >= 2) {
    const user1 = waitingQueue.shift();
    const user2 = waitingQueue.shift();
    const socket1 = io.sockets.sockets.get(user1.socketId);
    const socket2 = io.sockets.sockets.get(user2.socketId);

    if (!socket1 || !socket2) {
      if (socket1) waitingQueue.push(user1);
      if (socket2) waitingQueue.push(user2);
      console.log(`[${getTimestamp()}] MATCH_FAILED: One user disconnected during matching (sockets ${user1.socketId} and ${user2.socketId})`);
      continue;
    }

    const roomId = generateRoomId();
    rooms[roomId] = { users: [user1, user2], createdAt: new Date() };
    socket1.join(roomId);
    socket2.join(roomId);

    io.to(user1.socketId).emit('matched', { roomId, initiator: user1.userId });
    io.to(user2.socketId).emit('matched', { roomId, initiator: user1.userId });

    const counts = getCounts();
    console.log(`[${getTimestamp()}] MATCH_SUCCESS: Users ${user1.userId} and ${user2.userId} matched in room ${roomId}. Users: ${counts.users}, Rooms: ${counts.rooms}, Queue: ${counts.queue}`);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[${getTimestamp()}] SERVER_STARTED: Server started on port ${PORT}`);
});
