import requests
import json

with open("config/secrets.json") as f:
    config = json.load(f)

from utils.auth import get_access_token

ACCESS_TOKEN = get_access_token()
IG_USER_ID = config["instagram_user_id"]

def upload_image(image_url, caption=""):
    media_url = f"https://graph.facebook.com/v18.0/{IG_USER_ID}/media"
    publish_url = f"https://graph.facebook.com/v18.0/{IG_USER_ID}/media_publish"

    media_payload = {
        "image_url": image_url,
        "caption": caption,
        "access_token": ACCESS_TOKEN
    }

    media_res = requests.post(media_url, data=media_payload)
    media_id = media_res.json().get("id")

    if not media_id:
        print("Error uploading media:", media_res.json())
        return

    publish_payload = {
        "creation_id": media_id,
        "access_token": ACCESS_TOKEN
    }

    publish_res = requests.post(publish_url, data=publish_payload)
    print("Published:", publish_res.json())
