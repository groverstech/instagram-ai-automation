import requests, os
from dotenv import load_dotenv
load_dotenv()
def schedule_post(image_url, caption):
    token = os.getenv("BUFFER_ACCESS_TOKEN")
    profile = os.getenv("BUFFER_PROFILE_ID")
    res = requests.post("https://api.bufferapp.com/1/updates/create.json", data={"profile_ids": [profile], "text": caption, "media": {"photo": image_url}, "now": True}, headers={"Authorization": f"Bearer {token}"})
    return res.json()
