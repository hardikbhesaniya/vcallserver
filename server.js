const express = require('express');
const http = require('http');
const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);

// Waiting queue for users
let waitingQueue = [];
// Active rooms
let rooms = {};

// Generate random room ID
function generateRoomId() {
  return Math.random().toString(36).substring(2, 15);
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  // When user joins the waiting queue
  socket.on('join_queue', (data) => {
    const userId = data.userId;
    console.log(`User ${userId} joined the waiting queue`);
    
    // Add user to waiting queue
    waitingQueue.push({
      socketId: socket.id,
      userId: userId
    });
    
    // Match users if there are at least 2 in the queue
    matchUsers();
  });
  
  // Handle WebRTC signaling
  socket.on('offer', (data) => {
    io.to(data.roomId).emit('offer', data);
  });
  
  socket.on('answer', (data) => {
    io.to(data.roomId).emit('answer', data);
  });
  
  socket.on('ice_candidate', (data) => {
    io.to(data.roomId).emit('ice_candidate', data);
  });
  
  // Handle user skipping to next partner
  socket.on('skip', (data) => {
    const roomId = data.roomId;
    const userId = data.userId;
    
    if (rooms[roomId]) {
      // Notify the other user in the room
      const otherUserSocketId = rooms[roomId].users.find(u => u.userId !== userId)?.socketId;
      if (otherUserSocketId) {
        io.to(otherUserSocketId).emit('user_disconnected');
      }
      
      // Remove the room
      delete rooms[roomId];
    }
    
    // Add the skipping user back to the queue
    waitingQueue.push({
      socketId: socket.id,
      userId: userId
    });
    
    // Try to match users again
    matchUsers();
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Remove user from waiting queue
    waitingQueue = waitingQueue.filter(user => user.socketId !== socket.id);
    
    // Check if user is in a room
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const userIndex = room.users.findIndex(user => user.socketId === socket.id);
      
      if (userIndex !== -1) {
        // Notify the other user in the room
        const otherUserSocketId = room.users.find(u => u.socketId !== socket.id)?.socketId;
        if (otherUserSocketId) {
          io.to(otherUserSocketId).emit('user_disconnected');
        }
        
        // Remove the room
        delete rooms[roomId];
        break;
      }
    }
  });
});

// Function to match users in the waiting queue
function matchUsers() {
  while (waitingQueue.length >= 2) {
    // Get first two users from the queue
    const user1 = waitingQueue.shift();
    const user2 = waitingQueue.shift();
    
    // Create a new room
    const roomId = generateRoomId();
    rooms[roomId] = {
      users: [user1, user2]
    };
    
    // Join both users to the room
    io.sockets.sockets.get(user1.socketId)?.join(roomId);
    io.sockets.sockets.get(user2.socketId)?.join(roomId);
    
    // Notify users they have been matched
    io.to(user1.socketId).emit('matched', {
      roomId: roomId,
      initiator: user1.userId // First user will initiate the WebRTC connection
    });
    
    io.to(user2.socketId).emit('matched', {
      roomId: roomId,
      initiator: user1.userId 
    });
    
    console.log(`Matched ${user1.userId} and ${user2.userId} in room ${roomId}`);
  }
}

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});