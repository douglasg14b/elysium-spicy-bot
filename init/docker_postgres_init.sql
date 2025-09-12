DO $$
BEGIN
    -- Create user if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'discord_bot_user') THEN
        CREATE USER discord_bot_user WITH PASSWORD 'password';
    END IF;
END
$$;

-- Grant privileges if not already granted
GRANT ALL PRIVILEGES ON DATABASE discord_spicy_bot_db TO discord_bot_user;

\c discord_spicy_bot_db

-- Grant privileges
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO discord_bot_user;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO discord_bot_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO discord_bot_user;