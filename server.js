const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app); // Cambiamos a servidor HTTP para usar con Socket.IO
const io = new Server(server, { cors: { origin: '*' } }); // Habilitamos CORS para WebSockets

app.use(cors());
app.use(express.json());

// Configuración de conexión a PostgreSQL
const pool = new Pool({
  host: 'localhost',
  user: 'postgres',
  password: 'admin123',
  database: 'laliga',
  port: 5432
});

// Función para calcular puntos según los 3 sets
function calculatePoints(set1_a, set1_b, set2_a, set2_b, set3_a, set3_b) {
  let setsA = 0, setsB = 0;
  if (set1_a > set1_b) setsA++; else setsB++;
  if (set2_a > set2_b) setsA++; else setsB++;
  if (set3_a > set3_b) setsA++; else setsB++;

  let pointsA = 0, pointsB = 0;
  if (setsA === 2) {
    pointsA = 3;
    if (setsB === 1) pointsB = 1;
  } else if (setsB === 2) {
    pointsB = 3;
    if (setsA === 1) pointsA = 1;
  }
  return { pointsA, pointsB, setsA, setsB };
}

// Función para notificar cambios a los clientes
async function notifyClients() {
  const partidos = await pool.query('SELECT * FROM partidos ORDER BY id ASC');
  const clasificacion = await pool.query('SELECT * FROM clasificacion ORDER BY puntos DESC');
  io.emit('update', {
    partidos: partidos.rows,
    clasificacion: clasificacion.rows
  });
}

// GET /api/partidos
app.get('/api/partidos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM partidos ORDER BY id ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error en GET /api/partidos:', error);
    res.status(500).json({ error: 'Error al obtener partidos' });
  }
});

// POST /api/partidos
app.post('/api/partidos', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {
      equipo_a, equipo_b, set1_a, set1_b, set2_a, set2_b, set3_a, set3_b,
      jornada, lugar, hora, fecha
    } = req.body;

    const horaValida = (hora && hora.trim() !== '') ? hora : null;
    const fechaValida = (fecha && fecha.trim() !== '') ? fecha : new Date().toISOString();

    const insertQuery = `
      INSERT INTO partidos
        (equipo_a, equipo_b, set1_a, set1_b, set2_a, set2_b, set3_a, set3_b, jornada, lugar, hora, fecha)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING id
    `;
    const values = [
      equipo_a, equipo_b, Number(set1_a), Number(set1_b),
      Number(set2_a), Number(set2_b), Number(set3_a), Number(set3_b),
      Number(jornada), lugar, horaValida, fechaValida
    ];
    const result = await client.query(insertQuery, values);
    const newId = result.rows[0].id;

    const { pointsA, pointsB, setsA, setsB } = calculatePoints(
      Number(set1_a), Number(set1_b), Number(set2_a), Number(set2_b), Number(set3_a), Number(set3_b)
    );

    await client.query(`UPDATE clasificacion SET puntos = puntos + $1 WHERE equipo = $2`, [pointsA, equipo_a]);
    await client.query(`UPDATE clasificacion SET puntos = puntos + $1 WHERE equipo = $2`, [pointsB, equipo_b]);
    await client.query(
      `UPDATE clasificacion 
       SET sets_a_favor = sets_a_favor + $1, sets_en_contra = sets_en_contra + $2, diferencia = diferencia + ($1 - $2)
       WHERE equipo = $3`,
      [setsA, setsB, equipo_a]
    );
    await client.query(
      `UPDATE clasificacion 
       SET sets_a_favor = sets_a_favor + $1, sets_en_contra = sets_en_contra + $2, diferencia = diferencia + ($1 - $2)
       WHERE equipo = $3`,
      [setsB, setsA, equipo_b]
    );

    await client.query('COMMIT');
    res.json({ success: true, insertedId: newId, pointsA, pointsB });
    notifyClients(); // Notificar a los clientes después de insertar
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en POST /api/partidos:', error);
    res.status(500).json({ error: 'Error al insertar partido y actualizar clasificación' });
  } finally {
    client.release();
  }
});

// PUT /api/partidos/:id
app.put('/api/partidos/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const {
      equipo_a, equipo_b, set1_a, set1_b, set2_a, set2_b, set3_a, set3_b,
      jornada, lugar, hora, fecha
    } = req.body;
    const horaValida = (hora && hora.trim() !== '') ? hora : null;
    const fechaValida = (fecha && fecha.trim() !== '') ? fecha : new Date().toISOString();

    const updateQuery = `
      UPDATE partidos
      SET equipo_a = $1, equipo_b = $2, set1_a = $3, set1_b = $4, set2_a = $5, set2_b = $6,
          set3_a = $7, set3_b = $8, jornada = $9, lugar = $10, hora = $11, fecha = $12
      WHERE id = $13
    `;
    const values = [
      equipo_a, equipo_b, Number(set1_a), Number(set1_b), Number(set2_a), Number(set2_b),
      Number(set3_a), Number(set3_b), Number(jornada), lugar, horaValida, fechaValida, id
    ];
    await client.query(updateQuery, values);
    await client.query('COMMIT');
    res.json({ success: true });
    notifyClients(); // Notificar a los clientes después de actualizar
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en PUT /api/partidos/:id:', error);
    res.status(500).json({ error: 'Error al actualizar partido' });
  } finally {
    client.release();
  }
});

// DELETE /api/partidos/:id
app.delete('/api/partidos/:id', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('DELETE FROM partidos WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ success: true });
    notifyClients(); // Notificar a los clientes después de eliminar
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error en DELETE /api/partidos/:id:', error);
    res.status(500).json({ error: 'Error al eliminar partido' });
  } finally {
    client.release();
  }
});

// GET /api/clasificacion
app.get('/api/clasificacion', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clasificacion ORDER BY puntos DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error en GET /api/clasificacion:', error);
    res.status(500).json({ error: 'Error al obtener clasificación' });
  }
});

// GET /api/equipos
app.get('/api/equipos', async (req, res) => {
  try {
    const result = await pool.query('SELECT equipo FROM clasificacion ORDER BY equipo ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error en GET /api/equipos:', error);
    res.status(500).json({ error: 'Error al obtener equipos' });
  }
});

// Configuración de WebSockets
io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);
  notifyClients(); // Enviar datos iniciales al conectar
  socket.on('disconnect', () => console.log('Cliente desconectado:', socket.id));
});

server.listen(3000, () => {
  console.log('Servidor escuchando en http://localhost:3000');
});