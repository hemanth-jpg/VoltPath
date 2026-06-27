-- Supabase / PostgreSQL schema for VoltPath

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cars (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  brand TEXT,
  model TEXT,
  battery_range_km REAL NOT NULL,
  battery_capacity_kwh REAL,
  is_primary BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS route_history (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT,
  from_location TEXT NOT NULL,
  to_location TEXT NOT NULL,
  distance_km REAL,
  duration_min REAL,
  charging_stops INTEGER DEFAULT 0,
  route_data TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS favorite_routes (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  from_location TEXT NOT NULL,
  to_location TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
