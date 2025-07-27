from ai.caption_generator import generate_caption
from design.post_designer import create_image
from instagram.publish import upload_image

# Step 1: Generate caption
caption = generate_caption()

# Step 2: Create image with caption
image_path = create_image(caption)

# Step 3: Upload image to public server or S3 and get the URL
image_url = "https://yourdomain.com/path/to/uploaded/image.jpg"

# Step 4: Post to Instagram
upload_image(image_url, caption)
