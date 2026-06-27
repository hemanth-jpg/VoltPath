Deployment guide — Render + Supabase (free tier)

1) Create a Postgres database (Supabase or Neon)
   - Sign up at https://supabase.com and create a new project
   - Copy the `DATABASE_URL` (postgresql://...)

2) Set up GitHub repo
   - Ensure your code is in a GitHub repository (already done)

3) Configure Render
   - Create a new Web Service on Render
   - Connect your GitHub repository
   - Build Command: `pip install -r requirements.txt`
   - Start Command: `gunicorn app:app`
   - Environment variables (in Render > Environment):
     - `DATABASE_URL` = your Supabase/Neon connection string
     - `SECRET_KEY` = a secure random string
     - `GOOGLE_MAPS_API_KEY` = your Google Maps key
     - `OCM_API_KEY` = (optional) OpenChargeMap key
     - `FLASK_ENV` = production
     - `FLASK_DEBUG` = false

4) Optional: Use `render.yaml` if you want IaC for Render (not required)

5) Test the deployed app
   - Visit the Render URL
   - Register/login and confirm data persists in Supabase

6) Local testing
   - Copy `.env.example` to `.env` and fill values
   - Run locally:

```bash
python -m venv .venv
.venv/Scripts/activate
pip install -r requirements.txt
python app.py
```

Notes
- The app supports SQLite locally and Postgres via `DATABASE_URL` in production.
- `Procfile` exists for platforms that respect it.

   Supabase setup
   ----------------
   1. Create a Supabase project at https://app.supabase.com
   2. In the project dashboard go to "Database" → "SQL Editor"
   3. Open the file `supabase_init.sql` in this repo and paste its contents into the SQL Editor, then run it to create the tables.
   4. In "Settings" → "Database" copy the `DATABASE_URL` connection string.
   5. In Render, set `DATABASE_URL` to that value.

   Alternatively you can run the SQL locally with `psql` if you have the database credentials.

   Manual migration from app
   -------------------------
   If you prefer, the app will create tables automatically at startup when `DATABASE_URL` is set. To run migrations manually from your machine:

   ```powershell
   setx DATABASE_URL "<your-database-url>"
   refreshenv # or open a new shell
   .venv\Scripts\python.exe -c "import app; print('migration-run')"
   ```

   This will import the app which runs `init_db()` once and creates the schema.
