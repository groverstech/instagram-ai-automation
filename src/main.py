from src.generate_caption import generate_caption
from src.create_image import create_image
from src.schedule_post import schedule_post
from src.utils import upload_to_imgur
def main():
    caption = generate_caption("Motivational Quote")
    path = create_image(caption)
    url = upload_to_imgur(path)
    res = schedule_post(url, caption)
    print("✅ Post Scheduled:", res)
if __name__ == "__main__": main()
