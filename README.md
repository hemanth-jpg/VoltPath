# ⚡ VoltRoute — EV Charging Route Planner

A full-stack, production-ready EV Route Planner with smart charging stop recommendations, live charging station maps, user authentication, and garage management.

---
## 🔗Website link
##link:  https://voltpath-uru8.onrender.com/


## 📁 Project Structure

```
ev-planner/
├── app.py                  # Flask backend (main app)
├── requirements.txt        # Python dependencies
├── .env.example            # Environment variables template
├── instance/
│   └── ev_planner.db       # SQLite database (auto-created)
├── templates/
│   └── index.html          # Main SPA template
└── static/
    ├── css/
    │   └── style.css       # All styles (dark EV theme)
    └── js/
        └── app.js          # Frontend JavaScript
```

---

## 🚀 Quick Start (Local)

### Step 1 — Clone & Enter Folder
```bash
cd ev-planner
```

### Step 2 — Create Python Virtual Environment
```bash
python -m venv venv

# Activate (Mac/Linux):
source venv/bin/activate

# Activate (Windows):
venv\Scripts\activate
```

### Step 3 — Install Dependencies
```bash
pip install -r requirements.txt
```

### Step 4 — Set Up Environment Variables
```bash
cp .env.example .env
# Edit .env with your API keys (see "API Keys" section below)
```

### Step 5 — Run the App
```bash
python app.py
```

Open your browser at: **http://localhost:5000**

---

## 🔑 API Keys Setup

### 1. Google Maps API (Optional but recommended)
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project
3. Enable these APIs:
   - **Maps JavaScript API**
   - **Directions API**
   - **Places API**
   - **Geocoding API**
4. Create an API key under "Credentials"
5. Add it to `.env` as `GOOGLE_MAPS_API_KEY`

> **Without Google Maps**: The app automatically falls back to OpenStreetMap (Leaflet + OSRM) — fully functional, no API key needed!

### 2. OpenChargeMap API (Free)
1. Register at [OpenChargeMap](https://openchargemap.org/site/develop/api)
2. Get your free API key
3. Add to `.env` as `OCM_API_KEY`

> **Without OCM key**: Still works with rate-limited requests.

---

## 🌐 Features

### Guest Mode (No Login)
- ✅ Plan routes (From → To)
- ✅ View interactive map with route
- ✅ See charging stations along route
- ✅ Smart battery analysis & stop recommendations
- ✅ Find nearby charging stations
- ✅ Dark/Light mode toggle

### Logged-In Mode (Extra Features)
- ✅ Save vehicles with battery range
- ✅ Auto-fill battery range from primary car
- ✅ Route history (last 20 routes)
- ✅ Save favorite routes
- ✅ Quick-load previous routes

---

## 🔌 REST API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/api/register` | ❌ | Register new user |
| POST | `/api/login` | ❌ | Login |
| POST | `/api/logout` | ❌ | Logout |
| GET | `/api/me` | ❌ | Get session user |
| POST | `/api/save_car` | ✅ | Save a vehicle |
| GET | `/api/get_car` | ✅ | Get all vehicles |
| PUT | `/api/update_car/<id>` | ✅ | Update a vehicle |
| DELETE | `/api/delete_car/<id>` | ✅ | Delete a vehicle |
| POST | `/api/save_route` | Optional | Save route to history |
| GET | `/api/get_history` | ✅ | Get route history |
| POST | `/api/save_favorite` | ✅ | Save favorite route |
| GET | `/api/get_favorites` | ✅ | Get favorites |
| DELETE | `/api/delete_favorite/<id>` | ✅ | Remove favorite |
| GET | `/api/charging_stations` | ❌ | Nearby stations |
| POST | `/api/plan_route` | ❌ | Smart route analysis |

### Example: Plan a Route (POST /api/plan_route)
```json
// Request
{
  "distance_km": 450,
  "battery_range_km": 350,
  "current_charge_pct": 80,
  "waypoints": [{"lat": 12.97, "lng": 77.59}, ...]
}

// Response
{
  "total_distance_km": 450,
  "available_range_km": 280,
  "safe_range_km": 238,
  "stops_needed": 2,
  "can_complete_without_stop": false,
  "charging_recommendations": [
    {"stop_number": 1, "estimated_km_at_stop": 238, "charge_needed_pct": 80},
    {"stop_number": 2, "estimated_km_at_stop": 476, "charge_needed_pct": 80}
  ],
  "tip": "⚡ Two charging stops planned..."
}
```

---

## 🗄️ Database Schema

```sql
-- Users
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Cars / Vehicles
CREATE TABLE cars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    brand TEXT, model TEXT,
    battery_range_km REAL NOT NULL,
    battery_capacity_kwh REAL,
    is_primary BOOLEAN DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Route History
CREATE TABLE route_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    from_location TEXT NOT NULL,
    to_location TEXT NOT NULL,
    distance_km REAL,
    duration_min REAL,
    charging_stops INTEGER DEFAULT 0,
    route_data TEXT,  -- JSON
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Favorites
CREATE TABLE favorite_routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    from_location TEXT NOT NULL,
    to_location TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

---

## ☁️ Deployment

### Option A: Render (Backend — Free)
1. Push code to GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Set:
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `gunicorn app:app`
5. Add Environment Variables (from `.env`)
6. Deploy!

### Option B: Railway (Easier)
1. Install Railway CLI: `npm install -g @railway/cli`
2. `railway login`
3. `railway init`
4. `railway up`

### Vercel (Static Assets Only)
Vercel is for frontend-only. Since this is a full-stack Flask app, use Render or Railway for the whole app.

For full-stack deployment on Vercel using serverless:
1. Add `vercel.json`:
```json
{
  "builds": [{"src": "app.py", "use": "@vercel/python"}],
  "routes": [{"src": "/(.*)", "dest": "app.py"}]
}
```
2. `vercel deploy`

---

## 🧩 Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | HTML5, CSS3, Vanilla JavaScript |
| Backend | Python Flask |
| Database | SQLite (via sqlite3) |
| Maps | Google Maps API (or Leaflet/OSM fallback) |
| Routing | Google Directions API (or OSRM fallback) |
| EV Stations | OpenChargeMap API |
| Auth | Session-based (Werkzeug password hashing) |
| Fonts | Syne + DM Sans (Google Fonts) |

---

## 🎨 Design

- **Theme**: Dark electric (emerald green + cyan accents)
- **Typography**: Syne (display) + DM Sans (body)
- **Layout**: Sidebar nav + dashboard grid
- **Responsive**: Mobile-first with hamburger menu
- **Toggle**: Dark/Light mode switch

---

## 📝 License

Private  License - free to use  website  not a codes.

---

Made with ⚡ by VoltRoute
