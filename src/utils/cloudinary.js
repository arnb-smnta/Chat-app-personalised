import { v2 as cloudinary } from "cloudinary";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config({
  path: "./.env",
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const uploadOnCloudinary = async (localfilepath) => {
  cloudinary.api.ping((error, result) => {
    if (error) {
      console.error("Error testing Cloudinary configuration:", error);
    } else {
      console.log("Cloudinary is configured properly!");
      console.log("Cloudinary API response:", result);
    }
  });

  try {
    if (!localfilepath) {
      return null;
    }
    //upload the file on cloudinary

    const response = await cloudinary.uploader.upload(localfilepath, {
      resource_type: "auto",
    });

    //filehas been uploaded succesfully
    //console.log("file is uploaded on cloudinary succesfull", response);
    fs.unlinkSync(localfilepath); //removing the local file path as the file is uploaded succesfully
    return response;
  } catch (error) {
    fs.unlinkSync(localfilepath);
    //remove the local file path as the file upload has failed

    return null;
  }
};
const deleteOnCloudinary = async (public_id, mediatype = "image") => {
  try {
    // Test Cloudinary configuration
    await new Promise((resolve, reject) => {
      cloudinary.api.ping((error, result) => {
        if (error) {
          console.error("Error testing Cloudinary configuration:", error);
          reject(error);
        } else {
          console.log("Cloudinary is configured properly!");
          console.log("Cloudinary API response:", result);
          resolve(result);
        }
      });
    });

    console.log(public_id);

    if (!public_id) return null;

    // Delete file on Cloudinary
    const returnobject = await cloudinary.uploader.destroy(public_id, {
      resource_type: `${mediatype}`,
    });
    console.log(returnobject);
  } catch (err) {
    console.log(
      "Something went wrong while deleting the file on Cloudinary:",
      err
    );
  }
};
export { uploadOnCloudinary, deleteOnCloudinary };
