# Remote access with Tailscale

Use Tailscale to reach the Rainmaker hub from outside your home. No router ports are opened.

## What works without this

- **Siri and the Home app** work away from home through your Apple home hub (for example an Apple TV or HomePod).
- **Alexa** works away from home through Amazon's cloud.

You only need Tailscale for the Rainmaker app (coming later) when you are away from home.

## Set it up

1. Make a free Tailscale account at tailscale.com.
2. Install Tailscale on the always-on PC that runs the hub, and sign in.
3. Install Tailscale on your iPhone and iPad, and sign in with the same account. All three devices are now on one private network (a tailnet).
4. In the Tailscale admin page, find the PC's name. You can also see it in the Tailscale app. It looks like `my-pc` or `my-pc.example.ts.net`.
5. From your phone, with mobile data on and Wi-Fi off, open this in a browser:

   ```
   http://<pc-tailnet-name>:8787
   ```

   Use your own **App API port** if you changed it. A reply (even an error message from the hub) shows the PC is reachable.

6. Make sure Windows Firewall allows Node.js on the Tailscale network if it asks.

## The controller stays on your home network

- Do not install Tailscale on the controller. It cannot run it.
- Do not forward any router port to the controller.
- Do not make the controller reachable from the internet in any way.

The hub is the only thing that talks to the controller. Remote devices talk to the hub.

## Using it with the app

When the Rainmaker app is released, it will use the hub's address at home, and the tailnet address `http://<pc-tailnet-name>:8787` when you are away. You will enter the tailnet name once.

You can use WireGuard or another private network instead of Tailscale if you prefer. Anything that gives your phone a private route to the PC works.
