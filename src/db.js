import { createClient } from '@clickhouse/client';

const clickhouse = createClient({
    url: 'http://clickhouse-server:8123',
    username: 'default',
    password: '',
    database: 'default',
});

(async () => {
    try {
        // Kreiranje tabele `users`
        const createUsersTable = `
            CREATE TABLE IF NOT EXISTS users (
                wallet_address String,
                plan_type String,
                plan_start DateTime,
                plan_end DateTime,
                is_active UInt8 DEFAULT 1,
                created_at DateTime DEFAULT now()
            ) ENGINE = MergeTree()
            ORDER BY wallet_address
        `;
        await clickhouse.exec({
            query: createUsersTable,
        });

        // Kreiranje tabele `transactions`
        const createTransactionsTable = `
            CREATE TABLE IF NOT EXISTS transactions (
                wallet_address String,
                transaction_hash String,
                block_time DateTime,
                meta_data String,
                created_at DateTime DEFAULT now()
            ) ENGINE = MergeTree()
            ORDER BY (wallet_address, block_time)
        `;
        await clickhouse.exec({
            query: createTransactionsTable,
        });
    } catch (error) {
        console.error('Error creating tables:', error.message, error.stack);
    }
})();
export default clickhouse;
