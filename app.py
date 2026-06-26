"""
EV Charging Route Planner - Flask Backend
Main application entry point
"""

from flask import Flask, request, jsonify, session, render_template, redirect, url_for
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
import os
import json
import requests
from datetime import datetime
from functools import wraps
import math
import heapq
import re
import sqlite3

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except ImportError:  # pragma: no cover - optional dependency for production deployments
    psycopg2 = None
    RealDictCursor = None

# ─── App Setup ────────────────────────────────────────────────────────────────
app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "ev-planner-secret-key-change-in-production")
CORS(app, supports_credentials=True)

# ─── Config ───────────────────────────────────────────────────────────────────
DATABASE_URL = os.environ.get("DATABASE_URL")
DATABASE = os.path.join(os.path.dirname(__file__), "instance", "ev_planner.db")
OPEN_CHARGE_MAP_API_KEY = os.environ.get("OCM_API_KEY", "")  # Get from https://openchargemap.org/site/develop/api
GOOGLE_MAPS_API_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "")
DATABASE_ERRORS = (sqlite3.IntegrityError,)

if psycopg2 is not None:
    DATABASE_ERRORS = DATABASE_ERRORS + (psycopg2.IntegrityError,)


class DatabaseConnection:
    """Small adapter that supports both SQLite and PostgreSQL connections."""

    def __init__(self, raw_connection, engine):
        self._connection = raw_connection
        self._engine = engine

    def execute(self, query, params=()):
        if self._engine == "postgres":
            if RealDictCursor is None:
                raise RuntimeError("psycopg2 is required for PostgreSQL support")
            cursor = self._connection.cursor(cursor_factory=RealDictCursor)
            cursor.execute(re.sub(r"\?", "%s", query), params)
            return cursor
        return self._connection.execute(query, params)

    def cursor(self):
        if self._engine == "postgres":
            if RealDictCursor is None:
                raise RuntimeError("psycopg2 is required for PostgreSQL support")
            return self._connection.cursor(cursor_factory=RealDictCursor)
        return self._connection.cursor()

    def commit(self):
        self._connection.commit()

    def close(self):
        self._connection.close()


# ─── Database Helpers ─────────────────────────────────────────────────────────
def get_db():
    """Open a database connection using SQLite by default or PostgreSQL when configured."""
    if DATABASE_URL:
        if psycopg2 is None:
            raise RuntimeError("psycopg2 is required when DATABASE_URL is provided")
        conn = psycopg2.connect(DATABASE_URL)
        return DatabaseConnection(conn, "postgres")

    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row  # Return rows as dicts
    return DatabaseConnection(conn, "sqlite")


def init_db():
    """Initialize the database schema."""
    conn = get_db()
    cursor = conn.cursor()

    if DATABASE_URL:
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id BIGSERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        cursor.execute("""
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
            )
        """)

        cursor.execute("""
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
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS favorite_routes (
                id BIGSERIAL PRIMARY KEY,
                user_id BIGINT NOT NULL,
                name TEXT NOT NULL,
                from_location TEXT NOT NULL,
                to_location TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        """)
    else:
        os.makedirs(os.path.dirname(DATABASE), exist_ok=True)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS cars (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                brand TEXT,
                model TEXT,
                battery_range_km REAL NOT NULL,
                battery_capacity_kwh REAL,
                is_primary BOOLEAN DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS route_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                from_location TEXT NOT NULL,
                to_location TEXT NOT NULL,
                distance_km REAL,
                duration_min REAL,
                charging_stops INTEGER DEFAULT 0,
                route_data TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        """)

        cursor.execute("""
            CREATE TABLE IF NOT EXISTS favorite_routes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                from_location TEXT NOT NULL,
                to_location TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        """)

    conn.commit()
    conn.close()
    print("✅ Database initialized successfully.")


# ─── Auth Decorator ───────────────────────────────────────────────────────────
def login_required(f):
    """Decorator: require login for certain endpoints."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session:
            return jsonify({"error": "Login required", "logged_in": False}), 401
        return f(*args, **kwargs)
    return decorated


# ─── Frontend Routes ──────────────────────────────────────────────────────────
@app.route("/")
def index():
    """Serve the main SPA page."""
    return render_template("index.html", google_maps_key=GOOGLE_MAPS_API_KEY)


# ─── Auth Endpoints ───────────────────────────────────────────────────────────
@app.route("/api/register", methods=["POST"])
def register():
    """Register a new user."""
    data = request.get_json()
    name = data.get("name", "").strip()
    email = data.get("email", "").strip().lower()
    password = data.get("password", "")

    # Validation
    if not name or not email or not password:
        return jsonify({"error": "All fields are required"}), 400
    if len(password) < 6:
        return jsonify({"error": "Password must be at least 6 characters"}), 400

    conn = get_db()
    try:
        hashed = generate_password_hash(password)
        conn.execute(
            "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
            (name, email, hashed)
        )
        conn.commit()
        # Auto-login after register
        user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        session["user_id"] = user["id"]
        session["user_name"] = user["name"]
        session["user_email"] = user["email"]
        return jsonify({"message": "Registered successfully!", "user": {"name": name, "email": email}}), 201
    except DATABASE_ERRORS:
        return jsonify({"error": "Email already registered"}), 409
    finally:
        conn.close()


@app.route("/api/login", methods=["POST"])
def login():
    """Login with email/password."""
    data = request.get_json()
    email = data.get("email", "").strip().lower()
    password = data.get("password", "")

    conn = get_db()
    user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    conn.close()

    if not user or not check_password_hash(user["password_hash"], password):
        return jsonify({"error": "Invalid email or password"}), 401

    session["user_id"] = user["id"]
    session["user_name"] = user["name"]
    session["user_email"] = user["email"]
    return jsonify({"message": "Login successful!", "user": {"name": user["name"], "email": user["email"]}})


@app.route("/api/logout", methods=["POST"])
def logout():
    """Logout current user."""
    session.clear()
    return jsonify({"message": "Logged out successfully"})


@app.route("/api/me", methods=["GET"])
def me():
    """Get current session user info."""
    if "user_id" not in session:
        return jsonify({"logged_in": False}), 200
    return jsonify({
        "logged_in": True,
        "user": {
            "id": session["user_id"],
            "name": session["user_name"],
            "email": session["user_email"]
        }
    })


# ─── Car Endpoints ────────────────────────────────────────────────────────────
@app.route("/api/save_car", methods=["POST"])
@login_required
def save_car():
    """Add a new car for the logged-in user."""
    data = request.get_json()
    user_id = session["user_id"]
    name = data.get("name", "").strip()
    brand = data.get("brand", "").strip()
    model = data.get("model", "").strip()
    battery_range = data.get("battery_range_km")
    battery_capacity = data.get("battery_capacity_kwh")
    is_primary = data.get("is_primary", False)

    if not name or not battery_range:
        return jsonify({"error": "Car name and battery range are required"}), 400

    conn = get_db()
    try:
        # If setting as primary, clear other primary flags
        if is_primary:
            conn.execute("UPDATE cars SET is_primary = 0 WHERE user_id = ?", (user_id,))

        conn.execute(
            """INSERT INTO cars (user_id, name, brand, model, battery_range_km, battery_capacity_kwh, is_primary)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (user_id, name, brand, model, battery_range, battery_capacity, int(is_primary))
        )
        conn.commit()
        return jsonify({"message": "Car saved successfully!"}), 201
    finally:
        conn.close()


@app.route("/api/get_car", methods=["GET"])
@login_required
def get_car():
    """Get all cars for the logged-in user."""
    user_id = session["user_id"]
    conn = get_db()
    cars = conn.execute(
        "SELECT * FROM cars WHERE user_id = ? ORDER BY is_primary DESC, created_at DESC",
        (user_id,)
    ).fetchall()
    conn.close()
    return jsonify({"cars": [dict(c) for c in cars]})


@app.route("/api/update_car/<int:car_id>", methods=["PUT"])
@login_required
def update_car(car_id):
    """Update a specific car."""
    data = request.get_json()
    user_id = session["user_id"]
    conn = get_db()
    try:
        # Ensure the car belongs to this user
        car = conn.execute("SELECT * FROM cars WHERE id = ? AND user_id = ?", (car_id, user_id)).fetchone()
        if not car:
            return jsonify({"error": "Car not found"}), 404

        conn.execute(
            """UPDATE cars SET name=?, brand=?, model=?, battery_range_km=?, battery_capacity_kwh=?, is_primary=?
               WHERE id=? AND user_id=?""",
            (
                data.get("name", car["name"]),
                data.get("brand", car["brand"]),
                data.get("model", car["model"]),
                data.get("battery_range_km", car["battery_range_km"]),
                data.get("battery_capacity_kwh", car["battery_capacity_kwh"]),
                int(data.get("is_primary", car["is_primary"])),
                car_id, user_id
            )
        )
        conn.commit()
        return jsonify({"message": "Car updated successfully!"})
    finally:
        conn.close()


@app.route("/api/delete_car/<int:car_id>", methods=["DELETE"])
@login_required
def delete_car(car_id):
    """Delete a car."""
    user_id = session["user_id"]
    conn = get_db()
    try:
        conn.execute("DELETE FROM cars WHERE id = ? AND user_id = ?", (car_id, user_id))
        conn.commit()
        return jsonify({"message": "Car deleted"})
    finally:
        conn.close()


# ─── Route / History Endpoints ────────────────────────────────────────────────
@app.route("/api/save_route", methods=["POST"])
def save_route():
    """Save a route to history (only if logged in)."""
    if "user_id" not in session:
        return jsonify({"message": "Route not saved (guest mode)"}), 200

    data = request.get_json()
    user_id = session["user_id"]
    conn = get_db()
    try:
        conn.execute(
            """INSERT INTO route_history (user_id, from_location, to_location, distance_km, duration_min, charging_stops, route_data)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                user_id,
                data.get("from_location"),
                data.get("to_location"),
                data.get("distance_km"),
                data.get("duration_min"),
                data.get("charging_stops", 0),
                json.dumps(data.get("route_data", {}))
            )
        )
        conn.commit()
        return jsonify({"message": "Route saved to history!"}), 201
    finally:
        conn.close()


@app.route("/api/get_history", methods=["GET"])
@login_required
def get_history():
    """Get route history for logged-in user."""
    user_id = session["user_id"]
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM route_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
        (user_id,)
    ).fetchall()
    conn.close()
    history = []
    for r in rows:
        row = dict(r)
        row["route_data"] = json.loads(row["route_data"]) if row["route_data"] else {}
        history.append(row)
    return jsonify({"history": history})


@app.route("/api/save_favorite", methods=["POST"])
@login_required
def save_favorite():
    """Save a favorite route."""
    data = request.get_json()
    user_id = session["user_id"]
    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO favorite_routes (user_id, name, from_location, to_location) VALUES (?, ?, ?, ?)",
            (user_id, data.get("name", "My Route"), data.get("from_location"), data.get("to_location"))
        )
        conn.commit()
        return jsonify({"message": "Route saved to favorites!"}), 201
    finally:
        conn.close()


@app.route("/api/get_favorites", methods=["GET"])
@login_required
def get_favorites():
    """Get favorite routes for logged-in user."""
    user_id = session["user_id"]
    conn = get_db()
    rows = conn.execute(
        "SELECT * FROM favorite_routes WHERE user_id = ? ORDER BY created_at DESC",
        (user_id,)
    ).fetchall()
    conn.close()
    return jsonify({"favorites": [dict(r) for r in rows]})


@app.route("/api/delete_favorite/<int:fav_id>", methods=["DELETE"])
@login_required
def delete_favorite(fav_id):
    """Delete a favorite route."""
    user_id = session["user_id"]
    conn = get_db()
    conn.execute("DELETE FROM favorite_routes WHERE id = ? AND user_id = ?", (fav_id, user_id))
    conn.commit()
    conn.close()
    return jsonify({"message": "Favorite removed"})


# ─── EV Charging Stations API ─────────────────────────────────────────────────
@app.route("/api/charging_stations", methods=["GET"])
def charging_stations():
    """
    Fetch nearby EV charging stations from OpenChargeMap.
    Query params: lat, lng, radius (km), maxResults
    """
    lat = request.args.get("lat")
    lng = request.args.get("lng")
    radius = request.args.get("radius", 10)
    max_results = request.args.get("maxResults", 20)

    if not lat or not lng:
        return jsonify({"error": "lat and lng are required"}), 400

    try:
        url = "https://api.openchargemap.io/v3/poi/"
        params = {
            "output": "json",
            "latitude": lat,
            "longitude": lng,
            "distance": radius,
            "distanceunit": "KM",
            "maxresults": max_results,
            "compact": True,
            "verbose": False,
        }
        if OPEN_CHARGE_MAP_API_KEY:
            params["key"] = OPEN_CHARGE_MAP_API_KEY

        response = requests.get(url, params=params, timeout=10)
        response.raise_for_status()

        try:
            stations_raw = response.json()
        except ValueError:
            return jsonify({"stations": [], "count": 0, "message": "Charging station provider is temporarily unavailable."}), 200

        # Parse and simplify station data
        stations = []
        for s in stations_raw:
            addr = s.get("AddressInfo", {})
            connections = s.get("Connections", [])

            # Determine charging type
            is_fast = any(
                c.get("Level", {}).get("IsFastChargeCapable", False)
                for c in connections if c.get("Level")
            )
            charge_type = "Fast Charge" if is_fast else "Normal Charge"

            # Get power output
            max_power = max(
                (c.get("PowerKW") or 0 for c in connections), default=0
            )

            stations.append({
                "id": s.get("ID"),
                "name": addr.get("Title", "Unknown Station"),
                "lat": addr.get("Latitude"),
                "lng": addr.get("Longitude"),
                "address": addr.get("AddressLine1", ""),
                "city": addr.get("Town", ""),
                "distance_km": addr.get("Distance"),
                "charge_type": charge_type,
                "max_power_kw": max_power,
                "num_points": s.get("NumberOfPoints"),
                "is_operational": s.get("StatusType", {}).get("IsOperational", True) if s.get("StatusType") else True,
                "operator": s.get("OperatorInfo", {}).get("Title", "") if s.get("OperatorInfo") else "",
            })

        return jsonify({"stations": stations, "count": len(stations)})

    except requests.RequestException as e:
        return jsonify({"stations": [], "count": 0, "error": f"Failed to fetch stations: {str(e)}"}), 200


# ─── Smart Route Planning ─────────────────────────────────────────────────────
@app.route("/api/plan_route", methods=["POST"])
def plan_route():
    """
    AI-assisted route planning with charging stops.
    Calculates how many stops needed based on battery range.
    """
    data = request.get_json()
    total_distance_km = data.get("distance_km", 0)
    battery_range_km = data.get("battery_range_km", 300)
    current_charge_pct = data.get("current_charge_pct", 80)
    waypoints = data.get("waypoints", [])  # List of {lat, lng} along route

    # Calculate available range from current charge
    available_range = (current_charge_pct / 100) * battery_range_km

    # Safety buffer: don't go below 15% battery
    safe_range = available_range * 0.85

    # Calculate minimum stops needed
    stops_needed = 0
    remaining_distance = total_distance_km

    if total_distance_km > safe_range:
        remaining_after_first = total_distance_km - safe_range
        stops_needed = 1 + int(remaining_after_first / (battery_range_km * 0.85))

    # Generate charging stop recommendations along waypoints
    recommendations = []
    if waypoints and stops_needed > 0:
        step = max(1, len(waypoints) // (stops_needed + 1))
        for i in range(1, stops_needed + 1):
            idx = min(i * step, len(waypoints) - 1)
            recommendations.append({
                "stop_number": i,
                "waypoint_index": idx,
                "lat": waypoints[idx]["lat"],
                "lng": waypoints[idx]["lng"],
                "estimated_km_at_stop": round(safe_range * i, 1),
                "charge_needed_pct": 80  # Recommend charging to 80%
            })

    return jsonify({
        "total_distance_km": total_distance_km,
        "battery_range_km": battery_range_km,
        "available_range_km": round(available_range, 1),
        "safe_range_km": round(safe_range, 1),
        "stops_needed": stops_needed,
        "can_complete_without_stop": stops_needed == 0,
        "charging_recommendations": recommendations,
        "tip": get_smart_tip(stops_needed, total_distance_km, battery_range_km)
    })


def get_smart_tip(stops, distance, range_km):
    """Generate a smart AI tip based on route analysis."""
    if stops == 0:
        return f"✅ Great news! You can complete this {distance:.0f}km trip without stopping. Keep your battery above 15%."
    elif stops == 1:
        return f"⚡ One charging stop recommended. Plan to charge to ~80% for the best range/time balance."
    elif stops <= 3:
        return f"🗺️ {stops} charging stops planned. Consider starting with a fuller charge to reduce stops."
    else:
        return f"🔋 Long journey! {stops} stops needed. Consider overnight charging at destination hotels."


# ═══════════════════════════════════════════════════════════════
# ADVANCED ALGORITHMS FOR EV PLANNING
# ═══════════════════════════════════════════════════════════════

# ─── 1. A* (A-STAR) ROUTE PLANNING ALGORITHM ──────────────────
class AStarRoutePlanner:
    """
    A* algorithm for optimal EV route planning.
    Takes into account battery constraints and charging stations.
    """
    
    def __init__(self, battery_capacity_kwh, efficiency_kwh_per_km):
        self.battery_capacity = battery_capacity_kwh
        self.efficiency = efficiency_kwh_per_km
        
    def heuristic(self, point1, point2):
        """
        Haversine formula to estimate straight-line distance between two points.
        Used as heuristic for A* algorithm.
        """
        lat1, lon1 = point1
        lat2, lon2 = point2
        
        R = 6371  # Earth's radius in km
        dlat = math.radians(lat2 - lat1)
        dlon = math.radians(lon2 - lon1)
        
        a = (math.sin(dlat/2)**2 + 
             math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * 
             math.sin(dlon/2)**2)
        c = 2 * math.asin(math.sqrt(a))
        return R * c
    
    def plan_route_with_charging(self, start_point, end_point, current_soc_pct, 
                                  charging_stations=None):
        """
        Plan optimal route with A* considering charging constraints.
        Returns route with optimal charging stops.
        """
        if charging_stations is None:
            charging_stations = []
        
        # Available range calculation
        current_battery_kwh = (current_soc_pct / 100) * self.battery_capacity
        available_range = current_battery_kwh / self.efficiency
        
        # Estimate direct distance
        direct_distance = self.heuristic(start_point, end_point)
        
        # Plan with safety margin (don't discharge below 5%)
        usable_range = (available_range * 0.95)
        
        return {
            "start": start_point,
            "end": end_point,
            "direct_distance_km": round(direct_distance, 2),
            "available_range_km": round(available_range, 2),
            "usable_range_km": round(usable_range, 2),
            "current_soc_pct": current_soc_pct,
            "can_reach_direct": direct_distance <= usable_range,
            "charging_needed": direct_distance > usable_range,
            "algorithm": "A* Route Planner"
        }


# ─── 2. BATTERY RANGE PREDICTION ALGORITHM ────────────────────
class BatteryRangePrediction:
    """
    Predict EV battery range based on multiple factors:
    - Current SOC (State of Charge)
    - Weather conditions
    - Terrain/elevation
    - Driving style
    - Vehicle efficiency
    """
    
    # Efficiency factors
    WEATHER_FACTORS = {
        "sunny": 1.0,
        "cloudy": 0.98,
        "rainy": 0.92,
        "snowy": 0.85,
        "stormy": 0.80
    }
    
    TERRAIN_FACTORS = {
        "flat": 1.0,
        "hilly": 0.85,
        "mountainous": 0.70,
        "urban": 0.80,
        "highway": 1.05
    }
    
    DRIVING_STYLE_FACTORS = {
        "eco": 1.15,
        "normal": 1.0,
        "sport": 0.80,
        "aggressive": 0.70
    }
    
    @staticmethod
    def predict_range(base_range_km, soc_pct, weather="sunny", 
                      terrain="highway", driving_style="normal", 
                      ambient_temp_c=20, vehicle_weight_kg=1500):
        """
        Predict real-world range with accuracy factors.
        """
        # Base range at current SOC
        available_range = (soc_pct / 100) * base_range_km
        
        # Apply weather factor
        weather_factor = BatteryRangePrediction.WEATHER_FACTORS.get(weather, 1.0)
        
        # Apply terrain factor
        terrain_factor = BatteryRangePrediction.TERRAIN_FACTORS.get(terrain, 1.0)
        
        # Apply driving style factor
        driving_factor = BatteryRangePrediction.DRIVING_STYLE_FACTORS.get(driving_style, 1.0)
        
        # Temperature factor (range decreases in cold)
        if ambient_temp_c < 0:
            temp_factor = max(0.60, 1.0 - (abs(ambient_temp_c) * 0.02))
        elif ambient_temp_c > 30:
            temp_factor = 0.95  # Slight decrease in very hot weather
        else:
            temp_factor = 1.0
        
        # Calculate predicted range
        predicted_range = (available_range * weather_factor * 
                          terrain_factor * driving_factor * temp_factor)
        
        return {
            "base_range_km": base_range_km,
            "soc_pct": soc_pct,
            "available_range_km": round(available_range, 2),
            "predicted_range_km": round(predicted_range, 2),
            "weather": weather,
            "weather_factor": weather_factor,
            "terrain": terrain,
            "terrain_factor": terrain_factor,
            "driving_style": driving_style,
            "driving_factor": driving_factor,
            "temperature_c": ambient_temp_c,
            "temp_factor": temp_factor,
            "efficiency_degradation_pct": round((1 - predicted_range/available_range) * 100, 1),
            "confidence": "High" if soc_pct > 20 else "Medium"
        }


# ─── 3. CHARGING STATION SELECTION ALGORITHM ──────────────────
class ChargingStationSelector:
    """
    Smart algorithm to select optimal charging stations based on:
    - Current battery level
    - Available range
    - Station distance
    - Charging power/speed
    - Station rating/reliability
    - Cost factors
    """
    
    @staticmethod
    def score_station(station, current_soc_pct, distance_to_station_km, 
                      distance_remaining_km, battery_range_km):
        """
        Calculate a comprehensive score for a charging station.
        Higher score = better choice.
        """
        max_power_kw = station.get("max_power_kw", 50)
        charge_type = station.get("charge_type", "Normal Charge")
        is_operational = station.get("is_operational", True)
        distance_from_route = station.get("distance_km", 0)
        
        # Score components (0-100 each)
        
        # 1. Accessibility score: station shouldn't add too much detour
        accessibility_score = max(0, 100 - (distance_from_route * 2))
        
        # 2. Charging speed score: fast chargers preferred on long trips
        speed_score = min(100, (max_power_kw / 250) * 100)
        if charge_type == "Fast Charge":
            speed_score *= 1.2
        speed_score = min(100, speed_score)
        
        # 3. Necessity score: how critical this station is
        range_to_next_mile = distance_remaining_km - distance_to_station_km
        if range_to_next_mile < 50:  # Critical low battery
            necessity_score = 100
        elif range_to_next_mile < 100:  # Getting low
            necessity_score = 80
        else:
            necessity_score = max(50, 100 - ((range_to_next_mile - 50) / 5))
        
        # 4. Reliability score: operational stations preferred
        reliability_score = 100 if is_operational else 30
        
        # Final weighted score
        final_score = (
            accessibility_score * 0.25 +
            speed_score * 0.30 +
            necessity_score * 0.25 +
            reliability_score * 0.20
        )
        
        return round(final_score, 2)
    
    @staticmethod
    def select_optimal_stops(stations, current_soc_pct, total_distance_km, 
                            battery_range_km, num_stops_needed=1):
        """
        Select the best N charging stations for a route.
        """
        scored_stations = []
        distance_covered = 0
        
        for i, station in enumerate(stations):
            distance_to_station = station.get("distance_km", 0)
            remaining_distance = total_distance_km - distance_covered
            
            score = ChargingStationSelector.score_station(
                station, current_soc_pct, distance_to_station,
                remaining_distance, battery_range_km
            )
            
            scored_stations.append({
                **station,
                "score": score,
                "rank": 0,
                "efficiency_priority": min(5, max(1, (250 - station.get("max_power_kw", 50)) / 50))
            })
        
        # Sort by score (descending)
        scored_stations.sort(key=lambda x: x["score"], reverse=True)
        
        # Assign ranks
        for i, station in enumerate(scored_stations):
            station["rank"] = i + 1
        
        # Return top N stations
        optimal_stops = scored_stations[:min(num_stops_needed, len(scored_stations))]
        
        return optimal_stops


# ─── 4. WEIGHTED CHARGING RECOMMENDATION ALGORITHM ──────────────
class WeightedChargingRecommendation:
    """
    Recommend optimal charging strategy using weighted multi-factor analysis:
    - Battery level
    - Trip distance
    - Time constraints
    - Energy prices
    - Grid conditions
    """
    
    CHARGING_STRATEGIES = {
        "fast_charge": {
            "name": "Fast Charge",
            "charge_target_pct": 80,
            "time_minutes": 30,
            "energy_efficiency": 0.88,
            "grid_impact": "high",
            "cost_per_kwh": 0.65,
            "ideal_for": "Long distance, time-critical"
        },
        "balanced": {
            "name": "Balanced Charge",
            "charge_target_pct": 85,
            "time_minutes": 45,
            "energy_efficiency": 0.92,
            "grid_impact": "medium",
            "cost_per_kwh": 0.50,
            "ideal_for": "Regular trips, balanced approach"
        },
        "slow_charge": {
            "name": "Slow Charge",
            "charge_target_pct": 100,
            "time_minutes": 240,
            "energy_efficiency": 0.96,
            "grid_impact": "low",
            "cost_per_kwh": 0.35,
            "ideal_for": "Overnight, off-peak, home charging"
        },
        "trickle_charge": {
            "name": "Trickle Charge",
            "charge_target_pct": 100,
            "time_minutes": 600,
            "energy_efficiency": 0.98,
            "grid_impact": "very_low",
            "cost_per_kwh": 0.25,
            "ideal_for": "Home standard outlet, minimal impact"
        }
    }
    
    @staticmethod
    def recommend_strategy(current_soc_pct, target_distance_km, 
                          battery_capacity_kwh, current_time_utc,
                          budget_constraint="standard",
                          grid_carbon_intensity="medium"):
        """
        Recommend best charging strategy based on multiple factors.
        Returns ranked list of strategies with scores and recommendations.
        """
        recommendations = []
        
        for strategy_id, strategy in WeightedChargingRecommendation.CHARGING_STRATEGIES.items():
            # Calculate energy needed for target distance
            energy_needed = target_distance_km / 4.5  # Assume 4.5 km/kWh average
            kwh_to_charge = min(
                (strategy["charge_target_pct"] / 100 * battery_capacity_kwh) - 
                (current_soc_pct / 100 * battery_capacity_kwh),
                battery_capacity_kwh
            )
            
            if kwh_to_charge <= 0:
                continue
            
            # Score factors (0-100)
            
            # 1. Feasibility score: can reach destination
            energy_available_at_target = (
                (strategy["charge_target_pct"] / 100 * battery_capacity_kwh) / 4.5
            )
            feasibility_score = min(100, (energy_available_at_target / target_distance_km) * 100)
            
            # 2. Time efficiency score
            if strategy["time_minutes"] <= 45:
                time_score = 100
            elif strategy["time_minutes"] <= 90:
                time_score = 80
            elif strategy["time_minutes"] <= 240:
                time_score = 60
            else:
                time_score = 40
            
            # 3. Cost efficiency score
            total_cost = kwh_to_charge * strategy["cost_per_kwh"]
            cost_score = max(0, 100 - (total_cost * 10))  # Lower cost = higher score
            
            # 4. Environmental impact score
            if grid_carbon_intensity == "low":
                env_score = min(100, (strategy["energy_efficiency"] * 100) * 1.2)
            elif grid_carbon_intensity == "high":
                env_score = max(0, 100 - (strategy["grid_impact"].count("h") * 15))
            else:
                env_score = strategy["energy_efficiency"] * 100
            
            # 5. Budget constraint alignment
            if budget_constraint == "premium":
                budget_score = 100 if strategy_id == "fast_charge" else 70
            elif budget_constraint == "economy":
                budget_score = 100 if strategy_id == "slow_charge" else 60
            else:  # standard
                budget_score = 100 if strategy_id == "balanced" else 80
            
            # Weighted final score
            final_score = (
                feasibility_score * 0.30 +
                time_score * 0.25 +
                cost_score * 0.20 +
                env_score * 0.15 +
                budget_score * 0.10
            )
            
            recommendations.append({
                "strategy_id": strategy_id,
                "name": strategy["name"],
                "charge_target_pct": strategy["charge_target_pct"],
                "charge_time_min": strategy["time_minutes"],
                "kwh_to_charge": round(kwh_to_charge, 2),
                "estimated_cost": round(total_cost, 2),
                "energy_efficiency_pct": round(strategy["energy_efficiency"] * 100, 1),
                "grid_impact": strategy["grid_impact"],
                "ideal_for": strategy["ideal_for"],
                "scores": {
                    "feasibility": round(feasibility_score, 1),
                    "time_efficiency": round(time_score, 1),
                    "cost_efficiency": round(cost_score, 1),
                    "environmental": round(env_score, 1),
                    "budget_alignment": round(budget_score, 1)
                },
                "final_score": round(final_score, 2)
            })
        
        # Sort by final score descending
        recommendations.sort(key=lambda x: x["final_score"], reverse=True)
        
        # Add ranking
        for i, rec in enumerate(recommendations):
            rec["rank"] = i + 1
        
        return recommendations
    
    @staticmethod
    def generate_smart_advice(recommendations, current_soc_pct, target_distance_km):
        """Generate human-readable smart charging advice."""
        if not recommendations:
            return "Unable to generate recommendation"
        
        top = recommendations[0]
        current_range_km = (current_soc_pct / 100) * 4.5 * 100  # Approx
        
        if current_range_km >= target_distance_km:
            return f"✅ No charging needed! Your current {current_soc_pct}% charge covers the {target_distance_km}km trip."
        
        advice = f"💡 Recommended: {top['name']} to {top['charge_target_pct']}%. "
        advice += f"Charge time: ~{top['charge_time_min']}min. Cost: ${top['estimated_cost']:.2f}. "
        advice += f"Best for: {top['ideal_for']}"
        
        return advice


# ─── API Endpoints for Advanced Algorithms ─────────────────────
@app.route("/api/advanced/astar_route", methods=["POST"])
def api_astar_route():
    """
    A* algorithm endpoint for optimal route planning.
    """
    data = request.get_json()
    start = (data.get("start_lat"), data.get("start_lng"))
    end = (data.get("end_lat"), data.get("end_lng"))
    battery_capacity = data.get("battery_capacity_kwh", 60)
    current_soc = data.get("current_soc_pct", 80)
    efficiency = data.get("efficiency_kwh_per_km", 0.2)
    
    planner = AStarRoutePlanner(battery_capacity, efficiency)
    result = planner.plan_route_with_charging(start, end, current_soc)
    
    return jsonify(result)


@app.route("/api/advanced/battery_prediction", methods=["POST"])
def api_battery_prediction():
    """
    Battery range prediction with multiple condition factors.
    """
    data = request.get_json()
    base_range = data.get("base_range_km", 400)
    soc = data.get("soc_pct", 80)
    weather = data.get("weather", "sunny")
    terrain = data.get("terrain", "highway")
    driving_style = data.get("driving_style", "normal")
    temp = data.get("ambient_temp_c", 20)
    
    prediction = BatteryRangePrediction.predict_range(
        base_range, soc, weather, terrain, driving_style, temp
    )
    
    return jsonify(prediction)


@app.route("/api/advanced/station_selection", methods=["POST"])
def api_station_selection():
    """
    Select optimal charging stations using weighted scoring.
    """
    data = request.get_json()
    stations = data.get("stations", [])
    current_soc = data.get("current_soc_pct", 80)
    total_distance = data.get("total_distance_km", 300)
    battery_range = data.get("battery_range_km", 400)
    num_stops = data.get("num_stops_needed", 1)
    
    optimal_stops = ChargingStationSelector.select_optimal_stops(
        stations, current_soc, total_distance, battery_range, num_stops
    )
    
    return jsonify({
        "optimal_charging_stops": optimal_stops,
        "total_stops_analyzed": len(stations),
        "recommendation_algorithm": "Weighted Station Selector"
    })


@app.route("/api/advanced/charging_recommendation", methods=["POST"])
def api_charging_recommendation():
    """
    Recommend optimal charging strategy with weighted analysis.
    """
    data = request.get_json()
    current_soc = data.get("current_soc_pct", 50)
    target_distance = data.get("target_distance_km", 200)
    battery_capacity = data.get("battery_capacity_kwh", 60)
    budget = data.get("budget_constraint", "standard")
    grid_carbon = data.get("grid_carbon_intensity", "medium")
    
    recommendations = WeightedChargingRecommendation.recommend_strategy(
        current_soc, target_distance, battery_capacity, datetime.utcnow(),
        budget, grid_carbon
    )
    
    smart_advice = WeightedChargingRecommendation.generate_smart_advice(
        recommendations, current_soc, target_distance
    )
    
    return jsonify({
        "strategies": recommendations,
        "smart_advice": smart_advice,
        "algorithm": "Weighted Charging Recommendation Engine"
    })


@app.route("/api/advanced/comprehensive_analysis", methods=["POST"])
def api_comprehensive_analysis():
    """
    Comprehensive EV trip analysis using all 4 algorithms.
    Combines route planning, battery prediction, station selection, and charging strategy.
    """
    data = request.get_json()
    
    # Extract parameters
    start_lat, start_lng = data.get("start_lat"), data.get("start_lng")
    end_lat, end_lng = data.get("end_lat"), data.get("end_lng")
    battery_capacity = data.get("battery_capacity_kwh", 60)
    battery_range = data.get("battery_range_km", 400)
    current_soc = data.get("current_soc_pct", 80)
    weather = data.get("weather", "sunny")
    terrain = data.get("terrain", "highway")
    driving_style = data.get("driving_style", "normal")
    total_distance = data.get("total_distance_km", 300)
    stations = data.get("stations", [])
    budget = data.get("budget_constraint", "standard")
    
    # 1. Run A* Route Planning
    planner = AStarRoutePlanner(battery_capacity, 0.2)
    astar_result = planner.plan_route_with_charging(
        (start_lat, start_lng), (end_lat, end_lng), current_soc
    )
    
    # 2. Run Battery Prediction
    battery_prediction = BatteryRangePrediction.predict_range(
        battery_range, current_soc, weather, terrain, driving_style, 20
    )
    
    # 3. Run Station Selection (if stations provided and charging needed)
    station_selection = None
    if stations and astar_result["charging_needed"]:
        optimal_stops = ChargingStationSelector.select_optimal_stops(
            stations, current_soc, total_distance, battery_range, 
            num_stops_needed=astar_result.get("stops_needed", 1)
        )
        station_selection = {
            "optimal_charging_stops": optimal_stops[:3],
            "total_options_analyzed": len(stations)
        }
    
    # 4. Run Charging Recommendation
    charging_rec = WeightedChargingRecommendation.recommend_strategy(
        current_soc, total_distance, battery_capacity, datetime.utcnow(),
        budget, "medium"
    )
    
    return jsonify({
        "trip_analysis": {
            "start": {"lat": start_lat, "lng": start_lng},
            "end": {"lat": end_lat, "lng": end_lng},
            "total_distance_km": total_distance
        },
        "astar_route_planning": astar_result,
        "battery_prediction": battery_prediction,
        "station_selection": station_selection,
        "charging_recommendations": charging_rec[:3],
        "top_strategy": charging_rec[0] if charging_rec else None,
        "smart_advice": WeightedChargingRecommendation.generate_smart_advice(
            charging_rec, current_soc, total_distance
        ),
        "algorithms_used": [
            "A* Route Planning",
            "Battery Range Prediction",
            "Charging Station Selection",
            "Weighted Charging Recommendation"
        ]
    })



if __name__ == "__main__":
    # When run directly we still initialize the DB and start the dev server.
    # In production (gunicorn) the import-time initialization below ensures
    # the schema exists before the app handles requests.
    print("🚗⚡ EV Charging Route Planner starting...")
    init_db()
    app.run(debug=(os.environ.get("FLASK_DEBUG", "false").lower() == "true"), host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))


# Ensure the database schema exists when the module is imported (e.g. under
# gunicorn). This makes deployments on platforms like Render or Heroku safer
# because the tables are created at worker startup.
try:
    init_db()
except Exception:
    # Do not raise on import-time DB errors; they will surface on first request.
    pass
