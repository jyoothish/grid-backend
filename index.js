import express from "express";
import cors from "cors";
import pkg from "pg";
import dotenv from "dotenv";
import multer from "multer";
import csv from "csv-parser";
import fs from "fs";

const upload = multer({ dest: "uploads/" });
const SEASON_1_LIMIT = 12000;


function adminAuth(req, res, next) {
    const secret = req.headers["x-admin-secret"];

    if (!secret || secret !== process.env.ADMIN_SECRET) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    next();
}


dotenv.config();

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

async function processUsernamesUpload(client, usernames) {
    let added = 0;
    let skipped = 0;

    // 🔒 CHECK CURRENT COUNT
    const countResult = await client.query(
        "SELECT COUNT(*) FROM usernames"
    );
    let currentCount = parseInt(countResult.rows[0].count, 10);

    for (let raw of usernames) {

        // 🔒 ENFORCE SEASON LIMIT
        if (currentCount >= SEASON_1_LIMIT) {
            break; // stop inserting further
        }

        const username = raw.trim().toLowerCase();
        if (!username) {
            skipped++;
            continue;
        }

        const exists = await client.query(
            "SELECT 1 FROM usernames WHERE username = $1",
            [username]
        );

        if (exists.rowCount > 0) {
            skipped++;
            continue;
        }

        const cellResult = await client.query(`
            SELECT cell_id
            FROM cells
            WHERE filled = FALSE
            FOR UPDATE SKIP LOCKED
            LIMIT 1
        `);

        if (cellResult.rowCount === 0) {
            break;
        }

        const cellId = cellResult.rows[0].cell_id;

        await client.query(
            "INSERT INTO usernames (username, cell_id) VALUES ($1, $2)",
            [username, cellId]
        );

        await client.query(
            "UPDATE cells SET filled = TRUE WHERE cell_id = $1",
            [cellId]
        );

        added++;
        currentCount++; // 🔒 increment local counter
    }

    return { added, skipped };
}



app.get("/", (req, res) => {
    res.send("Backend is running");
});

app.get("/test-db", async (req, res) => {
    try {
        const result = await pool.query("SELECT COUNT(*) FROM cells");
        res.json({
            success: true,
            total_cells: result.rows[0].count,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false });
    }
});

app.get("/season", (req, res) => {
    res.json({
        season: 1,
        limit: SEASON_1_LIMIT
    });
});


app.get("/grid", async (req, res) => {
    const offset = parseInt(req.query.offset || "0");
    const limit = parseInt(req.query.limit || "5000");

    const result = await pool.query(
        `SELECT
    c.cell_id,
    c.x,
    c.y,
    c.is_mask,
    u.username
    FROM cells c
    LEFT JOIN usernames u ON c.cell_id = u.cell_id
    ORDER BY c.cell_id
    LIMIT $1 OFFSET $2`,
        [limit, offset]
    );

    res.json({ data: result.rows });
});


app.get("/search/:username", async (req, res) => {
    try {
        const username = req.params.username.toLowerCase();

        const result = await pool.query(
            "SELECT cell_id FROM usernames WHERE username = $1",
            [username]
        );

        if (result.rows.length === 0) {
            return res.json({ found: false });
        }

        res.json({
            found: true,
            cell_id: result.rows[0].cell_id,
            username: username
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ found: false });
    }
});

app.get("/progress", async (req, res) => {
    const result = await pool.query("SELECT COUNT(*) FROM usernames");
    res.json({ filled: parseInt(result.rows[0].count) });
});


app.post("/admin/upload", adminAuth, async (req, res) => {
    const { usernames } = req.body;

    if (!Array.isArray(usernames) || usernames.length === 0) {
        return res.status(400).json({ success: false, message: "No usernames provided" });
    }

    let added = 0;
    let skipped = 0;

    const client = await pool.connect();

    try {
        for (let name of usernames) {
            const username = name.trim().toLowerCase();
            if (!username) {
                skipped++;
                continue;
            }

            // Skip if username already exists
            const exists = await client.query(
                "SELECT 1 FROM usernames WHERE username = $1",
                [username]
            );
            if (exists.rows.length > 0) {
                skipped++;
                continue;
            }

            // Find a free cell
            const freeCell = await client.query(
                "SELECT cell_id FROM cells WHERE filled = FALSE FOR UPDATE SKIP LOCKED LIMIT 1"
            );

            if (freeCell.rows.length === 0) {
                break; // grid full
            }

            const cellId = freeCell.rows[0].cell_id;

            // Transaction per username (SAFE)
            await client.query("BEGIN");

            await client.query(
                "INSERT INTO usernames (username, cell_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
                [username, cellId]
            );

            await client.query(
                "UPDATE cells SET filled = TRUE WHERE cell_id = $1",
                [cellId]
            );

            await client.query("COMMIT");

            added++;
        }

        res.json({
            success: true,
            added,
            skipped,
        });
    } catch (error) {
        await client.query("ROLLBACK");
        console.error(error);
        res.status(500).json({ success: false });
    } finally {
        client.release();
    }
});

app.post(
    "/admin/upload-preview",
    adminAuth,
    upload.single("file"),
    async (req, res) => {
        if (!req.file) {
            return res.status(400).json({ success: false, message: "No file uploaded" });
        }

        const usernames = new Set();

        fs.createReadStream(req.file.path)
            .pipe(csv())
            .on("data", (row) => {
                const name = Object.values(row)[0];
                if (name) {
                    usernames.add(name.trim().toLowerCase());
                }
            })
            .on("end", async () => {
                fs.unlinkSync(req.file.path); // cleanup temp file

                const list = Array.from(usernames);

                if (list.length === 0) {
                    return res.json({ success: true, total: 0 });
                }

                // Check duplicates in DB
                const result = await pool.query(
                    "SELECT username FROM usernames WHERE username = ANY($1)",
                    [list]
                );

                const existing = result.rows.map((r) => r.username);
                const newOnes = list.filter((u) => !existing.includes(u));

                res.json({
                    success: true,
                    total_in_file: list.length,
                    already_exists: existing.length,
                    ready_to_insert: newOnes.length,
                    usernames: newOnes, // send only new usernames
                });
            });
    }
);

app.post("/admin/upload-confirm", adminAuth, async (req, res) => {
    const { usernames } = req.body;

    if (!Array.isArray(usernames) || usernames.length === 0) {
        return res.status(400).json({ success: false, message: "No usernames provided" });
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const result = await processUsernamesUpload(client, usernames);

        await client.query("COMMIT");

        res.json({
            success: true,
            ...result,
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error(err);
        res.status(500).json({ success: false, message: "Confirm upload failed" });
    } finally {
        client.release();
    }
});



const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
