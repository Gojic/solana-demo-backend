import express from 'express';
import cors from 'cors';
import walletRoutes from './routes/walletRoutes.js'
import authMiddleware from "./middleware/authMiddleware.js";

const app = express();
app.use(cors());
app.use(express.json());


app.use('/', walletRoutes);
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Internal server error' });
});
const PORT = 5000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
