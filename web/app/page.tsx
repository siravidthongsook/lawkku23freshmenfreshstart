import { redirect } from "next/navigation";

// Root → public events list.
export default function Home() {
  redirect("/events");
}
