import sharp from "sharp";
import pkg from "pg";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const { Pool } = pkg;

const GRID_SIZE = 256;      // ✅ FIXED
const THRESHOLD = 128;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const IMAGE_PATH = path.join(__dirname, "../mask.png");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

async function applyMask() {
    console.log("Applying image mask...");

    const { data } = await sharp(IMAGE_PATH)
        .resize(GRID_SIZE, GRID_SIZE)
        .grayscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

    let count = 0;

    for (let y = 0; y < GRID_SIZE; y++) {
        for (let x = 0; x < GRID_SIZE; x++) {
            const idx = y * GRID_SIZE + x;
            const brightness = data[idx];

            // black pixels → image
            if (brightness < THRESHOLD) {
                await pool.query(
                    `UPDATE cells SET is_mask = TRUE WHERE x = $1 AND y = $2`,
                    [x + 1, GRID_SIZE - y]
                );
                count++;
            }
        }
    }

    console.log(`Mask applied to ${count} cells`);
    process.exit(0);
}

applyMask().catch((err) => {
    console.error(err);
    process.exit(1);
});
