// A stylesheet imported by a server component: plugin-rsc renders its hashed
// URL as a <link> into this app's Flight, read at run time from the assets
// manifest, so no server chunk changes when the CSS does.
import "./note.css";

// An inline server action that closes over a value: plugin-rsc encrypts the
// bound argument with the build's encryption key, so this app's server code
// reaches the key and app B's does not.
export function Note({ id }: { id: string }) {
  async function save() {
    "use server";
    console.log("saved note", id);
  }
  return (
    <form action={save} className="note">
      <button type="submit">Save note {id}</button>
    </form>
  );
}
