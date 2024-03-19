import mongoose, { Schema } from "mongoose";

const chatSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
    },
    isGroupChat: {
      type: Boolean,
      default: false,
    },

    profilePic: {
      type: {
        url: String,
        localPath: String,
        public_id: String,
      },
    },
    description: { type: String },
    groupType: {
      type: String,
      enum: ["adminOnly", "everyone", null],
      default: null,
    },
    lastMessage: {
      type: Schema.Types.ObjectId,
      ref: "ChatMessage",
    },
    participants: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    admin: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
  },
  { timestamps: true }
);

export const Chat = mongoose.model("Chat", chatSchema);
