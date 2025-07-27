from ai.caption_generator import generate_caption
from design.image_generator import create_post_image
from meta.publisher import publish_to_instagram

if __name__ == "__main__":
    caption = generate_caption()
    print(f"Caption:\n{caption}")

    image_path = create_post_image(caption)
    print(f"Image created at: {image_path}")

    response = publish_to_instagram(image_path, caption)
    print("Publish Response:", response)