import os
import requests
from dotenv import load_dotenv

ENV_FILE = ".env"
load_dotenv()

def get_env_var(key):
    return os.getenv(key)

def update_env_var(key, value):
    lines = []
    updated = False
    with open(ENV_FILE, "r") as f:
        for line in f:
            if line.startswith(f"{key}="):
                lines.append(f"{key}={value}\n")
                updated = True
            else:
                lines.append(line)
    if not updated:
        lines.append(f"{key}={value}\n")
    with open(ENV_FILE, "w") as f:
        f.writelines(lines)

def get_access_token(auto_refresh=True):
    token = get_env_var("IG_ACCESS_TOKEN")
    if not token:
        raise ValueError("Missing IG_ACCESS_TOKEN in .env file")

    if auto_refresh:
        token = refresh_access_token(token)
    return token

def refresh_access_token(current_token):
    app_id = get_env_var("META_APP_ID")
    app_secret = get_env_var("META_APP_SECRET")

    if not app_id or not app_secret:
        print("⚠️ Cannot refresh token: Missing META_APP_ID or META_APP_SECRET.")
        return current_token

    print("🔁 Attempting to refresh access token...")
    url = "https://graph.facebook.com/v19.0/oauth/access_token"
    params = {
        "grant_type": "fb_exchange_token",
        "client_id": app_id,
        "client_secret": app_secret,
        "fb_exchange_token": current_token
    }

    response = requests.get(url, params=params)
    if response.status_code != 200:
        print("❌ Token refresh failed:", response.text)
        return current_token

    new_token = response.json().get("access_token")
    if new_token:
        update_env_var("IG_ACCESS_TOKEN", new_token)
        print("✅ Token refreshed and saved to .env.")
        return new_token
    else:
        print("⚠️ Token refresh did not return a new token.")
        return current_token