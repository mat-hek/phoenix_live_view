defmodule Phoenix.LiveViewTest.E2E.MultiSocketLive do
  use Phoenix.LiveView, container: {:div, "data-app": "main"}

  def mount(_params, _session, socket) do
    {:ok,
     socket
     |> assign(clicks: 0, keys: 0, text: nil)
     |> assign(:render_in_root, fn assigns ->
       ~H"""
       {live_render(@conn, Phoenix.LiveViewTest.E2E.MultiSocketLive.EmbeddedLive,
         session: %{"label" => "outside"}
       )}
       """
     end)}
  end

  def render(assigns) do
    ~H"""
    <h1>Main</h1>
    <button id="main-click" phx-click="inc">main-click</button>
    <span id="main-clicks">{@clicks}</span>
    <div phx-window-keydown="key"></div>
    <span id="main-keys">{@keys}</span>
    <form id="main-form" phx-change="text">
      <input id="main-input" type="text" name="text" phx-debounce="50" />
    </form>
    <span id="main-text">{@text}</span>
    <div id="embed-slot" phx-update="ignore"></div>
    <.link id="to-other-with-sticky" navigate="/multi-socket/other?sticky=1">other (with sticky)</.link>
    <.link id="to-other-without-sticky" navigate="/multi-socket/other">other (without sticky)</.link>
    {live_render(@socket, Phoenix.LiveViewTest.E2E.MultiSocketLive.EmbeddedLive,
      id: "sticky-embedded",
      sticky: true,
      session: %{"label" => "sticky"}
    )}
    """
  end

  def handle_event("inc", _params, socket) do
    {:noreply, update(socket, :clicks, &(&1 + 1))}
  end

  # typing into the inputs never produces Escape, so it never bumps the counter
  def handle_event("key", %{"key" => "Escape"}, socket) do
    {:noreply, update(socket, :keys, &(&1 + 1))}
  end

  def handle_event("key", _params, socket), do: {:noreply, socket}

  def handle_event("text", %{"text" => text}, socket) do
    {:noreply, assign(socket, :text, text)}
  end
end

# A second page to live-navigate to. Renders the embedded sticky root only
# when asked, so navigation can keep, add or drop it.
defmodule Phoenix.LiveViewTest.E2E.MultiSocketLive.OtherLive do
  use Phoenix.LiveView, container: {:div, "data-app": "main"}

  def mount(_params, _session, socket) do
    {:ok, assign(socket, clicks: 0)}
  end

  def handle_params(params, _uri, socket) do
    {:noreply, assign(socket, :sticky, params["sticky"] == "1")}
  end

  def render(assigns) do
    ~H"""
    <h1>Other</h1>
    <button id="other-click" phx-click="inc">other-click</button>
    <span id="other-clicks">{@clicks}</span>
    <div id="embed-slot" phx-update="ignore"></div>
    <.link id="to-main" navigate="/multi-socket">main</.link>
    <%= if @sticky do %>
      {live_render(@socket, Phoenix.LiveViewTest.E2E.MultiSocketLive.EmbeddedLive,
        id: "sticky-embedded",
        sticky: true,
        session: %{"label" => "sticky"}
      )}
    <% end %>
    """
  end

  def handle_event("inc", _params, socket) do
    {:noreply, update(socket, :clicks, &(&1 + 1))}
  end
end

defmodule Phoenix.LiveViewTest.E2E.MultiSocketLive.EmbedController do
  use Phoenix.Controller, formats: [:html]

  import Phoenix.LiveView.Controller

  def show(conn, %{"label" => label}) do
    conn
    |> put_root_layout(false)
    |> put_layout(false)
    |> live_render(Phoenix.LiveViewTest.E2E.MultiSocketLive.EmbeddedLive,
      session: %{"label" => label}
    )
  end
end

defmodule Phoenix.LiveViewTest.E2E.MultiSocketLive.EmbeddedLive do
  use Phoenix.LiveView, container: {:div, "data-app": "embedded"}

  def mount(_params, %{"label" => label}, socket) do
    {:ok, assign(socket, clicks: 0, keys: 0, text: nil, label: label)}
  end

  def render(assigns) do
    ~H"""
    <h2>Embedded {@label}</h2>
    <button data-role="click" phx-click="inc">emb-click</button>
    <span data-role="clicks">{@clicks}</span>
    <div phx-window-keydown="key"></div>
    <span data-role="keys">{@keys}</span>
    <form phx-change="text">
      <input type="text" name="text" phx-debounce="50" />
    </form>
    <span data-role="text">{@text}</span>
    <div id={"probe-#{@label}"} phx-hook="Probe"></div>
    """
  end

  def handle_event("inc", _params, socket) do
    {:noreply, update(socket, :clicks, &(&1 + 1))}
  end

  def handle_event("key", %{"key" => "Escape"}, socket) do
    {:noreply, update(socket, :keys, &(&1 + 1))}
  end

  def handle_event("key", _params, socket), do: {:noreply, socket}

  def handle_event("text", %{"text" => text}, socket) do
    {:noreply, assign(socket, :text, text)}
  end
end

defmodule Phoenix.LiveViewTest.E2E.MultiSocketLive.Layout do
  use Phoenix.Component

  # Boots two scoped LiveSockets instead of the default page-wide one.
  def render("live.html", assigns) do
    ~H"""
    <meta name="csrf-token" content={Plug.CSRFProtection.get_csrf_token()} />
    <script src="/assets/phoenix/phoenix.min.js">
    </script>
    <script type="module">
      import { LiveSocket } from "/assets/phoenix_live_view/phoenix_live_view.esm.js";
      // the outside embedded root is dead-rendered with this same layout,
      // duplicating this script in the page — boot the sockets only once
      if (!window.mainLiveSocket) {
        const csrfToken = document
          .querySelector("meta[name='csrf-token']")
          .getAttribute("content");
        const opts = { params: { _csrf_token: csrfToken } };
        window.mainLiveSocket = new LiveSocket("/live", window.Phoenix.Socket, {
          ...opts,
          viewSelector: "[data-app=main]",
        });
        // the embedded socket gets destroyed and re-created by the tests
        window.bootEmbedded = () => {
          window.embeddedLiveSocket = new LiveSocket("/live", window.Phoenix.Socket, {
            ...opts,
            viewSelector: "[data-app=embedded]",
            hooks: {
              Probe: {
                destroyed() {
                  window.probeDestroyed = (window.probeDestroyed || 0) + 1;
                },
              },
            },
          });
          window.embeddedLiveSocket.connect();
        };
        window.mainLiveSocket.connect();
        // model a real embedder: fetch the embedded app's disconnected
        // render, inject it into the slot the host never patches, and only
        // then boot the embedded socket so it discovers both of its roots
        const res = await fetch("/multi-socket/embed?label=nested");
        const doc = new DOMParser().parseFromString(await res.text(), "text/html");
        const container = doc.querySelector("[data-app=embedded]");
        document.getElementById("embed-slot").innerHTML = container.outerHTML;
        window.bootEmbedded();
      }
    </script>
    {@inner_content}
    """
  end
end
