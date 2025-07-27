from content.caption_generator import generate_caption
from content.image_generator import create_post_image

if __name__ == "__main__":
    caption = generate_caption("market trends")
    print("Generated Caption:", caption)

    image_path = create_post_image(caption)
    print("Image created at:", image_path)