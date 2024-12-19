import express from 'express';
import { Connection, clusterApiUrl, PublicKey } from '@solana/web3.js';
import clickhouse from '../db.js';

const router = express.Router();

//poziv za dodavanja plana korisniku
router.post('/api/wallet/subscribe', async (req, res) => {
    const { walletAddress, planType } = req.body;

    if (!walletAddress) {
        return res.status(400).json({ error: 'Wallet address is required' });
    }
    const validPlans = ['free_trial', 'three_months', 'yearly'];
    const selectedPlan = validPlans.includes(planType) ? planType : 'free_trial';

    const planStart = new Date();
    let planEnd;
    switch (selectedPlan) {
        case 'three_months':
            planEnd = new Date(planStart);
            planEnd.setMonth(planEnd.getMonth() + 3);
            break;
        case 'yearly':
            planEnd = new Date(planStart);
            planEnd.setFullYear(planEnd.getFullYear() + 1);
            break;
        default:
            // Free trial: 7 days
            planEnd = new Date(planStart);
            planEnd.setDate(planEnd.getDate() + 7);
    }

    try {
        let connection;
        try {
            connection = new Connection('https://solana-devnet.g.alchemy.com/v2/z4eFzZ8jXEyd70Z2HJzW91ttn0sksbJ0', 'confirmed');
        } catch (error) {
            console.error('Error connecting to Solana testnet:', error.message);
            return res.status(503).json({ error: 'Solana testnet is unavailable' });
        }

        const publicKey = new PublicKey(walletAddress);
        let signatures;
        try {
            signatures = await connection.getSignaturesForAddress(publicKey, { limit: 10 });
        } catch (error) {
            console.error("Error fetching signatures:", error);
            return res.status(503).json({ error: "Failed to fetch signatures", details: error.message });
        }
        const transactions = [];

        for (let sigInfo of signatures) {
            const tx = await connection.getTransaction(sigInfo.signature, { commitment: 'confirmed' });
            if (tx && tx.meta && tx.transaction) {
                transactions.push({
                    transaction_hash: sigInfo.signature,
                    block_time: new Date(tx.blockTime * 1000).toISOString(),
                    meta_data: JSON.stringify(tx.meta),

                });
            }
        }

        const existingUserResult = await clickhouse.query({
            query: `
                SELECT wallet_address, plan_type, plan_end
                FROM users
                WHERE wallet_address = '${walletAddress}'
                LIMIT 1
            `,
            format: 'JSONEachRow',
        });

        let existingUser = null;
        try {
            for await (const row of existingUserResult.stream()) {
                if (row && row.text) { // Proverimo da li row.text postoji
                    existingUser = JSON.parse(row.text);
                } else {
                    console.warn("Invalid row format:", row); // Loguj ako format nije validan
                }
            }
        } catch (err) {
            console.error("Error parsing existing user result:", err.message);
            return res.status(500).json({ error: "Failed to parse user data" });
        }
        if (existingUser) {
            console.log("Postojeći korisnik pronađen:", existingUser);

            await clickhouse.exec({
                query: `
                    ALTER TABLE users UPDATE 
                    plan_type = '${selectedPlan}', 
                    plan_start = '${planStart.toISOString().split('.')[0]}', 
                    plan_end = '${planEnd.toISOString().split('.')[0]}'
                    WHERE wallet_address = '${walletAddress}'
                `,
            });

            return res.json({
                message: `Plan updated to '${selectedPlan}' for wallet '${walletAddress}'.`,
            });
        } else {
            await clickhouse.insert({
                table: 'users',
                values: [
                    {
                        wallet_address: walletAddress,
                        plan_type: selectedPlan,
                        plan_start: planStart.toISOString().split('.')[0],
                        plan_end: planEnd.toISOString().split('.')[0],
                    }
                ],
                format: 'JSONEachRow',
            });

            console.log(`Novi korisnik dodat sa planom '${selectedPlan}'`);
        }

        /*     await clickhouse.insert(
                `INSERT INTO transactions (wallet_address, transaction_hash, block_time, meta_data)`,
                rows
            );*/
        try {
            const rows = transactions.map(tx => ({
                wallet_address: walletAddress,
                transaction_hash: tx.transaction_hash,
                block_time: tx.block_time.split('.')[0],
                meta_data: tx.meta_data,
            }));
            if (rows.length > 0) {
                await clickhouse.insert({
                    table: 'transactions',
                    values: rows,
                    format: 'JSONEachRow',
                });
            }
            res.json({
                message: `Transactions saved with plan '${selectedPlan}'.`,
                transactions
            });
        } catch (error) {
            console.error('Error inserting into ClickHouse:', error.message);
            res.status(500).json({ error: 'Failed to save data to ClickHouse' });
        }

    } catch (error) {
        console.error('Error adding plan:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Poziv za preuzimanje transakcija
router.get('/api/transactions/:walletAddress', async (req, res) => {
    const { walletAddress } = req.params;

    try {
        // Proveravam plan korisnika
        const userResult = await clickhouse.query({
            query: `
                SELECT plan_type, plan_start, plan_end, is_active
                FROM users
                WHERE wallet_address = '${walletAddress}' AND is_active = 1
            `,
            format: 'JSONEachRow',
        });


        const userRows = [];
        for await (const row of userResult.stream()) {
            if (Array.isArray(row) && row[0] && row[0].text) {
                try {
                    const parsedRow = JSON.parse(row[0].text);
                    userRows.push(parsedRow);
                } catch (err) {
                    console.error("Failed to parse row:", row, err.message);
                }
            } else {
                console.warn("Invalid row format:", row);
            }
        }

        const user = userRows[0];
        if (!user) {
            return res.status(404).json({ error: 'User not found or plan expired' });
        }

        // Provera isteka plana
        const now = new Date();
        const planEnd = new Date(user.plan_end);

        if (now > planEnd) {
            // Korisnik je neaktivan
            await clickhouse.exec({
                query: `
                    ALTER TABLE users UPDATE is_active = 0 WHERE wallet_address = '${walletAddress}'
                `,
            });

            return res.status(403).json({ error: 'Plan expired' });
        }

        // Kreiramo upit za transakcije
        let query = `
            SELECT *
            FROM transactions
            WHERE wallet_address = '${walletAddress}'
            
        `;
        console.log("user: ", user);
        if (user.plan_type === 'free_trial') {
            query += ` AND block_time > now() - INTERVAL 7 DAY`;
        } else if (user.plan_type === 'three_months') {
            query += ` AND block_time > now() - INTERVAL 3 MONTH`;
        } else if (user.plan_type === 'yearly') {
            query += ` AND block_time > now() - INTERVAL 1 YEAR`;
        }
        const transactionsResult = await clickhouse.query({
            query,
            format: 'JSONEachRow',

        });
        console.log("Final query:", query);
        // console.log("transactionsResult: ", transactionsResult);
        const transactions = [];
        for await (const row of transactionsResult.stream()) {
            console.log("Raw row:", row); // Loguj celokupan red
            try {
                // row je niz, iteriraj kroz sve elemente
                if (Array.isArray(row)) {
                    for (const item of row) {
                        const parsedRow = JSON.parse(item.text); // Parsiraš JSON iz 'text'
                        console.log("Parsed row:", parsedRow);

                        transactions.push({
                            transaction_hash: parsedRow.transaction_hash,
                            block_time: parsedRow.block_time,
                        });
                    }
                } else {
                    console.warn("Unexpected row format:", row);
                }
            } catch (err) {
                console.error("Error parsing transaction row:", err.message, row);
            }
        }

        console.log("transactions", transactions);


        console.log("transactions", transactions);
        if (userRows.length > 0) {
            return res.status(200).json({
                plan: user,
                transactions
            });
        } else {
            console.warn("No matching user data found.");
            return res.status(404).json({ error: "No data found for this wallet address." });
        }
    } catch (error) {
        console.error('Error fetching transactions:', error.message, error.stack);
        res.status(500).json({ error: 'Internal server error' });
    }
});


export default router;