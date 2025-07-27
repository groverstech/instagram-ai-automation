import os
import requests
from dotenv import load_dotenv

load_dotenv()

ACCESS_TOKEN = os.getenv("IG_ACCESS_TOKEN")
INSTAGRAM_ACCOUNT_ID = os.getenv("IG_ACCOUNT_ID")

def publish_to_instagram(image_path, caption):
    with open(image_path, 'rb') as img:
        upload_url = f"https://graph.facebook.com/v19.0/{INSTAGRAM_ACCOUNT_ID}/media"
        res = requests.post(upload_url, data={
            "caption": caption,
            "access_token": ACCESS_TOKEN
        }, files={"image": img})
        upload_id = res.json().get("id")

    publish_url = f"https://graph.facebook.com/v19.0/{INSTAGRAM_ACCOUNT_ID}/media_publish"
    pub_res = requests.post(publish_url, data={
        "creation_id": upload_id,
        "access_token": ACCESS_TOKEN
    })
    return pub_res.json()
