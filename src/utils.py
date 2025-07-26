import requests, os
from dotenv import load_dotenv
load_dotenv()
def upload_to_imgur(image_path):
    client_id = os.getenv("IMGUR_CLIENT_ID")
    with open(image_path, 'rb') as img:
        r = requests.post("https://api.imgur.com/3/image", headers={"Authorization": f"Client-ID {client_id}"}, files={"image": img})
    return r.json()['data']['link']
