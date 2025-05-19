// server.js
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import mqtt from "mqtt";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

// Get directory name in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
});

// Enable CORS for all routes
app.use(cors());
app.use(express.json());

// Serve static files from the Frontend directory
app.use(express.static(path.join(__dirname, '../Frontend')));

// Serve the index.html file for the root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../Frontend/index.html'));
});

// Motor states tracking
const motorStates = {
  motor1: "OFF",
  motor2: "OFF"
};

// Active users tracking
const activeUsers = new Set();

// MQTT client configuration
const mqttConfig = {
  host: 'mqtt.eclipseprojects.io',
  port: 1883,
  username: '123',
  password: '456',
  clientId: `mqtt_${Math.random().toString(16).slice(3)}`
};

// Connect to MQTT broker
const client = mqtt.connect(`mqtt://${mqttConfig.host}:${mqttConfig.port}`, {
  username: mqttConfig.username,
  password: mqttConfig.password,
  clientId: mqttConfig.clientId,
  reconnectPeriod: 5000
});

// MQTT connection handlers
client.on('connect', () => {
  console.log('✅ Connected to MQTT broker');
});

client.on('reconnect', () => {
  console.log('🔄 Attempting to reconnect to MQTT broker...');
});

client.on('error', (err) => {
  console.error('🛑 MQTT connection error:', err);
});

client.on('close', () => {
  console.log('❌ Disconnected from MQTT broker');
});

// Function to publish MQTT messages
const publishMessage = (topic, message) => {
  return new Promise((resolve, reject) => {
    if (!client.connected) {
      console.error(`Cannot publish to ${topic}: MQTT client not connected`);
      reject(new Error("MQTT client not connected"));
      return;
    }
    
    client.publish(topic, message, (err) => {
      if (err) {
        console.error(`Error publishing to ${topic}:`, err);
        reject(err);
      } else {
        console.log(`📤 Published to ${topic}: ${message}`);
        
        // Update motorStates
        if (topic === 'bocata/motor1') {
          motorStates.motor1 = message;
        } else if (topic === 'bocata/motor2') {
          motorStates.motor2 = message;
        }
        
        resolve();
      }
    });
  });
};

// API health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mqtt: client.connected ? 'connected' : 'disconnected',
    activeUsers: activeUsers.size,
    queueLength: queue.length,
    motorStates
  });
});

// Express routes for motor control
app.get('/motor/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  const safeAction = action.toUpperCase();
  
  if (!['1', '2'].includes(id) || !['ON', 'OFF', 'REVERSE'].includes(safeAction)) {
    return res.status(400).json({ error: 'Invalid parameters' });
  }

  try {
    await publishMessage(`bocata/motor${id}`, safeAction);
    res.json({ success: true, message: `Motor ${id} set to ${safeAction}` });
  } catch (error) {
    res.status(500).json({ error: 'Failed to publish message', details: error.message });
  }
});

// Individual routes for specific actions
app.get('/motor1/on', (req, res) => publishMessage('bocata/motor1', 'ON').then(() => res.json({ success: true })).catch(err => res.status(500).json({ error: err.message })));
app.get('/motor1/off', (req, res) => publishMessage('bocata/motor1', 'OFF').then(() => res.json({ success: true })).catch(err => res.status(500).json({ error: err.message })));
app.get('/motor1/reverse', (req, res) => publishMessage('bocata/motor1', 'REVERSE').then(() => res.json({ success: true })).catch(err => res.status(500).json({ error: err.message })));
app.get('/motor2/on', (req, res) => publishMessage('bocata/motor2', 'ON').then(() => res.json({ success: true })).catch(err => res.status(500).json({ error: err.message })));
app.get('/motor2/off', (req, res) => publishMessage('bocata/motor2', 'OFF').then(() => res.json({ success: true })).catch(err => res.status(500).json({ error: err.message })));
app.get('/motor2/reverse', (req, res) => publishMessage('bocata/motor2', 'REVERSE').then(() => res.json({ success: true })).catch(err => res.status(500).json({ error: err.message })));

// Socket.io queue management
const TURN_DURATION = 10000; // 10 seconds
let queue = []; // [{ id: socket.id, expiresAt: timestamp | null }]

io.on("connection", (socket) => {
  console.log("👋 User connected:", socket.id);
  activeUsers.add(socket.id);

  // Add user to queue
  queue.push({ id: socket.id, expiresAt: null });
  updateQueue();
  startNextIfNeeded();

  // Handle user interactions
  socket.on("interact", () => {
    if (queue[0]?.id === socket.id && queue[0].expiresAt !== null) {
      console.log(`🎮 User ${socket.id} interacted!`);
    }
  });

  // Handle disconnection
  socket.on("disconnect", () => {
    console.log("👋 User disconnected:", socket.id);
    activeUsers.delete(socket.id);
    
    // Clean up user's motors if they were active
    const isActive = queue[0]?.id === socket.id;
    if (isActive) {
      // Turn off both motors if the active user disconnects
      publishMessage('bocata/motor1', 'OFF').catch(console.error);
      publishMessage('bocata/motor2', 'OFF').catch(console.error);
    }
    
    // Remove from queue
    queue = queue.filter(client => client.id !== socket.id);
    updateQueue();
    startNextIfNeeded();
  });
});

function updateQueue() {
  const now = Date.now();
  let currentStart = queue[0]?.expiresAt ? queue[0].expiresAt - TURN_DURATION : now;

  const queueWithTimes = queue.map((client, idx) => {
    const startAt = currentStart + idx * TURN_DURATION;
    return {
      id: client.id,
      spot: idx + 1,
      expiresAt: (idx === 0 && client.expiresAt) ? client.expiresAt : null,
      startAt: startAt,
      active: idx === 0 && client.expiresAt && now < client.expiresAt
    };
  });

  io.emit("queueUpdate", queueWithTimes);
  
  // Log queue status periodically (every 20 seconds)
  if (now % 20000 < 250) {
    console.log(`📊 Queue status: ${queue.length} users waiting`);
    if (queue.length > 0) {
      console.log(`🏆 Current active user: ${queue[0].id.substring(0, 8)}...`);
    }
  }
}

function startNextIfNeeded() {
  if (queue.length > 0 && queue[0].expiresAt === null) {
    queue[0].expiresAt = Date.now() + TURN_DURATION;
    console.log(`🎲 Starting turn for user ${queue[0].id.substring(0, 8)}...`);
    updateQueue();

    setTimeout(() => {
      if (queue[0] && queue[0].expiresAt && Date.now() >= queue[0].expiresAt) {
        const finishedClient = queue.shift(); // Remove from front
        console.log(`⌛ Turn ended for user ${finishedClient.id.substring(0, 8)}`);
        
        // Reset motors when turn is over
        publishMessage('bocata/motor1', 'OFF').catch(console.error);
        publishMessage('bocata/motor2', 'OFF').catch(console.error);
        
        finishedClient.expiresAt = null; // Reset timer
        queue.push(finishedClient); // Add back to end
        updateQueue();
        startNextIfNeeded(); // Move to the next user automatically
      }
    }, TURN_DURATION);
  }
}

// Graceful shutdown handling
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down gracefully...');
  
  // Turn off all motors
  try {
    await publishMessage('bocata/motor1', 'OFF');
    await publishMessage('bocata/motor2', 'OFF');
    console.log('✅ Motors turned off');
  } catch (err) {
    console.error('❌ Failed to turn off motors:', err);
  }
  
  // Close MQTT connection
  client.end(true, () => {
    console.log('✅ MQTT connection closed');
  });
  
  // Close HTTP server
  httpServer.close(() => {
    console.log('✅ HTTP server closed');
    process.exit(0);
  });
  
  // Force exit after 3 seconds if still running
  setTimeout(() => {
    console.log('⚠️ Forcing exit after timeout');
    process.exit(1);
  }, 3000);
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});