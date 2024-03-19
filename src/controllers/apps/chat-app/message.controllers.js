import mongoose from "mongoose";
import { ChatEventEnum } from "../../../constants.js";
import { Chat } from "../../../models/apps/chat-app/chat.models.js";
import { ChatMessage } from "../../../models/apps/chat-app/message.models.js";
import { emitSocketEvent } from "../../../socket/index.js";
import { ApiError } from "../../../utils/ApiError.js";
import { ApiResponse } from "../../../utils/ApiResponse.js";
import { asyncHandler } from "../../../utils/asyncHandler.js";
import { getLocalPath, getStaticFilePath } from "../../../utils/helpers.js";
import {
  deleteOnCloudinary,
  uploadOnCloudinary,
} from "../../../utils/cloudinary.js";

/**
 * @description Utility function which returns the pipeline stages to structure the chat message schema with common lookups
 * @returns {mongoose.PipelineStage[]}
 */
const chatMessageCommonAggregation = () => {
  return [
    {
      $lookup: {
        from: "users",
        foreignField: "_id",
        localField: "sender",
        as: "sender",
        pipeline: [
          {
            $project: {
              username: 1,
              avatar: 1,
              email: 1,
            },
          },
        ],
      },
    },
    {
      $addFields: {
        sender: { $first: "$sender" },
      },
    },
  ];
};

const getAllMessages = asyncHandler(async (req, res) => {
  const { chatId } = req.params;

  const selectedChat = await Chat.findById(chatId);

  if (!selectedChat) {
    throw new ApiError(404, "Chat does not exist");
  }

  // Only send messages if the logged in user is a part of the chat he is requesting messages of
  if (!selectedChat.participants?.includes(req.user?._id)) {
    throw new ApiError(400, "User is not a part of this chat");
  }

  const messages = await ChatMessage.aggregate([
    {
      $match: {
        chat: new mongoose.Types.ObjectId(chatId),
      },
    },
    ...chatMessageCommonAggregation(),
    {
      $sort: {
        createdAt: -1,
      },
    },
  ]);

  return res
    .status(200)
    .json(
      new ApiResponse(200, messages || [], "Messages fetched successfully")
    );
});

const sendMessage = asyncHandler(async (req, res) => {
  const { chatId } = req.params;
  const { content } = req.body;
  console.log(chatId);

  if (!content && !req.files?.attachments?.length) {
    throw new ApiError(400, "Message content or attachment is required");
  }

  const selectedChat = await Chat.findById(chatId);

  if (!selectedChat) {
    throw new ApiError(404, "Chat does not exist");
  }

  //check for group chat type for sending message

  if (selectedChat.isGroupChat) {
    if (selectedChat.groupType === "adminOnly") {
      if (
        !selectedChat.admin.some(
          (admin) => admin.toString() === req.user._id.toString()
        )
      ) {
        throw new ApiError(
          401,
          "You are not authorised to send message in this chat only admins can"
        );
      }
    }
  }

  const messageFiles = [];

  if (req.files && req.files.attachments?.length > 0) {
    req.files.attachments?.map((attachment) => {
      messageFiles.push({
        url: getStaticFilePath(req, attachment.filename),
        localPath: getLocalPath(attachment.filename),
      });
    });
  }

  const cloudinaryUrl = [];

  //uploading the static files
  if (messageFiles.length > 0) {
    await Promise.all(
      messageFiles.map(async (files) => {
        console.log(files.localPath, "files");
        const url = await uploadOnCloudinary(files.localPath);
        //creating the attachment object
        cloudinaryUrl.push({
          url: url.url,
          localPath: files.localPath,
          public_id: url.public_id,
        });
      })
    );
  }

  console.log(cloudinaryUrl[0]);
  // Create a new message instance with appropriate metadata
  const message = await ChatMessage.create({
    sender: new mongoose.Types.ObjectId(req.user._id),
    content: content || "",
    chat: new mongoose.Types.ObjectId(chatId),
    attachments: cloudinaryUrl,
  });

  // update the chat's last message which could be utilized to show last message in the list item
  const chat = await Chat.findByIdAndUpdate(
    chatId,
    {
      $set: {
        lastMessage: message._id,
      },
    },
    { new: true }
  );

  // structure the message
  const messages = await ChatMessage.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(message._id),
      },
    },
    ...chatMessageCommonAggregation(),
  ]);

  // Store the aggregation result
  const receivedMessage = messages[0];

  if (!receivedMessage) {
    throw new ApiError(500, "Internal server error");
  }

  // logic to emit socket event about the new message created to the other participants
  chat.participants.forEach((participantObjectId) => {
    // here the chat is the raw instance of the chat in which participants is the array of object ids of users
    // avoid emitting event to the user who is sending the message
    if (participantObjectId.toString() === req.user._id.toString()) return;

    // emit the receive message event to the other participants with received message as the payload
    emitSocketEvent(
      req,
      participantObjectId.toString(),
      ChatEventEnum.MESSAGE_RECEIVED_EVENT,
      receivedMessage
    );
  });

  return res
    .status(201)
    .json(new ApiResponse(201, receivedMessage, "Message saved successfully"));
});

const deleteMessage = asyncHandler(async (req, res) => {
  //Controller to delete chat messages

  const { chatId, messageId } = req.params;

  //Find the chat based on chat id

  const chat = await Chat.findOne({
    _id: new mongoose.Types.ObjectId(chatId),
  });

  if (!chat) {
    throw new ApiError(404, "Chat does not exist");
  }
  //Find the message based on message id
  const message = await ChatMessage.findOne({
    _id: new mongoose.Types.ObjectId(messageId),
  });

  if (!message) {
    throw new ApiError(404, "Message does not exist");
  }

  //Checking for group chat

  if (chat.isGroupChat) {
    if (
      message.sender?.toString() === req.user._id?.toString() ||
      chat.admin?.some((user) => user?.toString() === req.user._id?.toString())
    ) {
      //If the sender is admin then delete the message immidiately
      if (
        chat.admin?.some(
          (user) => user?.toString() === req.user._id?.toString()
        )
      ) {
        await ChatMessage.deleteOne({
          _id: new mongoose.Types.ObjectId(messageId),
        })
          .then(async (result) => {
            //see if the message has attachments then have to delete the messages from cloudinary

            if (message.attachments.length > 0) {
              await Promise.all(
                message.attachments.map(
                  async (assets) => await deleteOnCloudinary(assets.public_id)
                )
              );
            }

            //updating the last message of the chat
            const lastMessage = await ChatMessage.findOne(
              { chat: chatId },
              {},
              { sort: { createdAt: -1 } }
            );
            await Chat.findByIdAndUpdate(chatId, {
              lastMessage: lastMessage ? lastMessage?._id : null,
            });

            // logic to emit socket event about the message deleted  to the other participants
            chat.participants.forEach((participantObjectId) => {
              // here the chat is the raw instance of the chat in which participants is the array of object ids of users
              // avoid emitting event to the user who is deleting the message
              if (participantObjectId.toString() === req.user._id.toString())
                return;

              // emit the delete message event to the other participants frontend with delete message as the payload
              emitSocketEvent(
                req,
                participantObjectId.toString(),
                ChatEventEnum.MESSAGE_DELETED_EVENT,
                message
              );
            });

            return res
              .status(200)
              .json(new ApiResponse(200, {}, "Message Deleted Successfully"));
          })
          .catch((err) => {
            throw new ApiError(500, "Internal Server Error Try again");
          });
      }
      //We do not need to check for admins only group because sender can only be admin so the if will not execute

      //Checking time 15 mins to delete the message sent by user
      if (message.sender?.toString() === req.user._id?.toString()) {
        const currentTime = new Date();
        const messageCreatedAt = message.createdAt;
        const timeDifferenceMinutes =
          (currentTime - messageCreatedAt) / (1000 * 60);

        if (timeDifferenceMinutes < 15) {
          await ChatMessage.deleteOne({
            _id: new mongoose.Types.ObjectId(messageId),
          })
            .then(async (result) => {
              //see if the message has attachments then have to delete the messages from cloudinary

              if (message.attachments.length > 0) {
                await Promise.all(
                  message.attachments.map(
                    async (assets) => await deleteOnCloudinary(assets.public_id)
                  )
                );
              }

              //updating the last message of the chat
              const lastMessage = await ChatMessage.findOne(
                { chat: chatId },
                {},
                { sort: { createdAt: -1 } }
              );
              await Chat.findByIdAndUpdate(chatId, {
                lastMessage: lastMessage ? lastMessage?._id : null,
              });

              // logic to emit socket event about the message deleted  to the other participants
              chat.participants.forEach((participantObjectId) => {
                // here the chat is the raw instance of the chat in which participants is the array of object ids of users
                // avoid emitting event to the user who is deleting the message
                if (participantObjectId.toString() === req.user._id.toString())
                  return;

                // emit the delete message event to the other participants frontend with delete message as the payload
                emitSocketEvent(
                  req,
                  participantObjectId.toString(),
                  ChatEventEnum.MESSAGE_DELETED_EVENT,
                  message
                );
              });
              return res
                .status(200)
                .json(new ApiResponse(200, {}, "Message Deleted Successfully"));
            })
            .catch((err) => {
              throw new ApiError(500, "Internal Server Error Try again");
            });
        }

        throw new ApiError(
          400,
          "15 mins has passed you cannot delete this message"
        );
      }
    }
    //If user is not the admin or the sender
    throw new ApiError(401, "You are not authorised to delete the message");
  }

  //One On One Chat Cases

  if (message.sender?.toString() === req.user._id?.toString()) {
    const currentTime = new Date();
    const messageCreatedAt = message.createdAt;
    const timeDifferenceMinutes =
      (currentTime - messageCreatedAt) / (1000 * 60);

    if (timeDifferenceMinutes < 15) {
      await ChatMessage.deleteOne({
        _id: new mongoose.Types.ObjectId(messageId),
      })
        .then(async (result) => {
          //see if the message has attachments then have to delete the messages from cloudinary

          if (message.attachments.length > 0) {
            await Promise.all(
              message.attachments.map(
                async (assets) => await deleteOnCloudinary(assets.public_id)
              )
            );
          }

          //updating the last message of the chat
          const lastMessage = await ChatMessage.findOne(
            { chat: chatId },
            {},
            { sort: { createdAt: -1 } }
          );

          // logic to emit socket event about the message deleted  to the other participants
          chat.participants.forEach((participantObjectId) => {
            // here the chat is the raw instance of the chat in which participants is the array of object ids of users
            // avoid emitting event to the user who is deleting the message
            if (participantObjectId.toString() === req.user._id.toString())
              return;

            // emit the delete message event to the other participants frontend with delete message as the payload
            emitSocketEvent(
              req,
              participantObjectId.toString(),
              ChatEventEnum.MESSAGE_DELETED_EVENT,
              message
            );
          });
          return res
            .status(200)
            .json(new ApiResponse(200, {}, "Message Deleted Successfully"));
        })
        .catch((err) => {
          throw new ApiError(500, "Internal Server Error Try again");
        });
    }

    throw new ApiError(
      400,
      "15 mins has passed you cannot delete this message"
    );
  }
  //If the user is not the sender
  throw new ApiError(401, "You are not authorised to delete this message");
});

export { getAllMessages, sendMessage, deleteMessage };
