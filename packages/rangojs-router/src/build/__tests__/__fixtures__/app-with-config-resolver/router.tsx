import { createRouter } from "@rangojs/router";
import { shopUrls } from "~routes/shop";

export const router = createRouter().routes(shopUrls);
