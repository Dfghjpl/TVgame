const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.get('/player', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));

function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.family === 'IPv4') return iface.address;
    }
  }
  return 'localhost';
}

const localIp = getLocalIp();
app.get('/get-ip', (req, res) => res.json({ ip: localIp }));

let players = [];
let currentPlayerIndex = 0;
let roundActive = false;
let currentWord = '';
let timerInterval = null;
let correctAnswers = [];
let attempts = {};
let actorId = null;
let playersNotified = {};
const disconnectTimers = {}; // playerId -> timeout

const icons = ['🦄', '🐸', '🐼', '🐨', '🐯', '🦊', '🐷', '🐵', '🦉', '🐧', '🐙', '🦋', '🐉', '🎈', '🍕', '🚀', '🌈', '👾'];
const wordsList = ['Крокодил', 'Телефон', 'Самолёт', 'Робот', 'Пицца', 'Танец', 'Космос', 'Зонт', 'Кошка', 'Велосипед', 'Гитара', 'Снеговик', 'Пингвин', 'Торт', 'Фонарь', 'Ключ', 'Виноград', 'Медведь', 'Облако', 'Пирамида'];
const getRandomWord = () => wordsList[Math.floor(Math.random() * wordsList.length)];

const stopTimer = () => { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } };

const startRound = () => {
  if (players.filter(p => p.id !== null).length < 2) return;
  
  currentWord = getRandomWord();
  roundActive = true;
  correctAnswers = [];
  attempts = {};
  playersNotified = {};
  actorId = players[currentPlayerIndex].id;
  
  players.forEach(p => { if (p.id !== actorId && p.id !== null) attempts[p.id] = 0; });

  players.forEach(p => {
    if (!p.id) return;
    if (p.id === actorId) io.to(p.id).emit('actor-word', { word: currentWord });
    else io.to(p.id).emit('guessing-mode');
  });
  
  io.emit('round-active', { actorName: players[currentPlayerIndex].name });

  let timeLeft = 30;
  io.emit('timer-update', timeLeft);
  stopTimer();
  timerInterval = setInterval(() => {
    timeLeft--;
    if (timeLeft >= 0) io.emit('timer-update', timeLeft);
    if (timeLeft < 0) { stopTimer(); endRound(false); }
  }, 1000);
};

const endRound = (someoneGuessed = false) => {
  roundActive = false;
  stopTimer();
  for (let id of correctAnswers) {
    const p = players.find(pl => pl.id === id);
    if (p) p.score++;
  }
  io.emit('players-update', players);

  players.forEach(p => {
    if (!p.id || playersNotified[p.id]) return;
    if (p.id === actorId) {
      const guessers = correctAnswers.map(id => players.find(pl => pl.id === id)?.name).join(', ') || 'Никто';
      io.to(p.id).emit('actor-timeout', { word: currentWord, guessedBy: guessers });
    } else {
      const guessed = correctAnswers.includes(p.id);
      const msg = guessed ? '🎉 Вы угадали!' : (someoneGuessed ? 'Кто-то угадал раньше' : '⏰ Время вышло');
      io.to(p.id).emit('round-result', { correct: guessed, message: msg, word: currentWord });
    }
    playersNotified[p.id] = true;
  });
  io.emit('time-up-finished');
};

io.on('connection', (socket) => {
  console.log('Подключение:', socket.id);

  socket.on('player-join', (data) => {
    // ✅ Поддержка старого и нового формата
    const name = typeof data === 'string' ? data : data?.name;
    const playerId = typeof data === 'object' ? data?.playerId : null;

    if (!name || !name.trim()) return;
    const playerName = name.trim();

    // 🔍 Поиск игрока по уникальному ID (для восстановления при обновлении)
    let player = playerId ? players.find(p => p.playerId === playerId) : null;

    if (player) {
      // ♻️ Реконнект: игрок уже был в игре
      clearTimeout(disconnectTimers[playerId]);
      delete disconnectTimers[playerId];
      
      player.id = socket.id; // Обновляем сокет
      player.name = playerName; // На случай, если имя изменилось
      
      io.emit('players-update', players);

      // Восстанавливаем текущее состояние игры
      if (roundActive) {
        if (player.id === actorId) socket.emit('actor-word', { word: currentWord });
        else if (!playersNotified[player.id]) socket.emit('guessing-mode');
        else socket.emit('waiting-screen');
      } else {
        socket.emit('waiting-screen');
      }
      return;
    }

    // 🆕 Новый игрок
    const icon = icons[Math.floor(Math.random() * icons.length)];
    players.push({ id: socket.id, name: playerName, score: 0, icon, playerId: playerId || `guest_${Date.now()}` });
    
    socket.emit('waiting-screen');
    io.emit('players-update', players);
  });

  socket.on('request-start-round', () => startRound());
  
  socket.on('next-turn', () => {
    if (roundActive) return;
    currentPlayerIndex = (currentPlayerIndex + 1) % (players.length || 1);
    io.emit('current-actor-name', { name: players[currentPlayerIndex]?.name || 'Ожидание' });
    startRound();
  });

  socket.on('guess-word', (guess) => {
    if (!roundActive || socket.id === actorId || correctAnswers.includes(socket.id) || playersNotified[socket.id]) return;
    if (!guess || !guess.trim()) return;

    const isCorrect = guess.trim().toLowerCase() === currentWord.toLowerCase();
    if (isCorrect) {
      correctAnswers.push(socket.id);
      const pName = players.find(p => p.id === socket.id)?.name || 'Игрок';
      io.emit('someone-guessed', { name: pName, word: currentWord });
      io.to(socket.id).emit('guess-feedback', { correct: true, message: 'Верно!' });
      endRound(true);
    } else {
      attempts[socket.id] = (attempts[socket.id] || 0) + 1;
      const remaining = 3 - attempts[socket.id];
      const msg = remaining <= 0 ? 'Попытки закончились!' : `Неверно. Осталось: ${remaining}`;
      io.to(socket.id).emit('guess-feedback', { correct: false, message: msg, remaining });
      if (remaining <= 0) playersNotified[socket.id] = true;
    }
  });

  socket.on('skip-word', () => {
    if (!roundActive || socket.id !== actorId) return;
    currentWord = getRandomWord();
    io.to(actorId).emit('actor-word', { word: currentWord });
    io.emit('word-skipped', { actorName: players.find(p => p.id === actorId)?.name });
  });

  socket.on('disconnect', () => {
    console.log('Отключение:', socket.id);
    const player = players.find(p => p.id === socket.id);
    if (!player) return;

    // ⏳ Даём 45 секунд на возвращение (обновление страницы, лаги)
    if (player.playerId) {
      disconnectTimers[player.playerId] = setTimeout(() => {
        players = players.filter(p => p.playerId !== player.playerId);
        delete disconnectTimers[player.playerId];
        io.emit('players-update', players);
        
        // Если все ушли — сбрасываем раунд
        if (players.filter(p => !disconnectTimers[p.playerId]).length === 0 && roundActive) {
          roundActive = false; stopTimer(); io.emit('waiting-screen');
        }
      }, 45000);
    }
  });
});


// ... (весь ваш код выше без изменений) ...

// 🔧 Поддержка облака + автоочистка при бездействии
const PORT = process.env.PORT || 3000;
let lastActivity = Date.now();
const INACTIVITY_LIMIT = 30 * 60 * 1000; // 30 минут бездействия

setInterval(() => {
  if (Date.now() - lastActivity > INACTIVITY_LIMIT) {
    console.log('⏳ Очистка после 30 мин бездействия...');
    players = []; currentPlayerIndex = 0; roundActive = false; 
    currentWord = ''; correctAnswers = []; attempts = {}; 
    playersNotified = {}; actorId = null; stopTimer();
    io.emit('players-update', []);
    io.emit('waiting-screen');
  }
}, 5 * 60 * 1000); // проверка каждые 5 минут

const resetActivity = () => { lastActivity = Date.now(); };
io.on('connection', resetActivity);
io.on('disconnect', resetActivity);
io.on('player-join', resetActivity);
io.on('request-start-round', resetActivity);
io.on('guess-word', resetActivity);
io.on('next-turn', resetActivity);

server.listen(PORT, () => {
  console.log(`🎮 Сервер запущен на порту ${PORT}`);
  if (PORT !== 3000) console.log(`🌐 Доступен по адресу: https://ваше-приложение.onrender.com`);
});