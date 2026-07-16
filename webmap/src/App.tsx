import { MapProvider } from "react-map-gl/maplibre";
import MapView from "./components/MapView";
import LayerPanel from "./components/LayerPanel";
import ChatPanel from "./components/ChatPanel";
import "./App.css";

// Layout only - all state lives in the layer store (state/mapStore.ts),
// which the LayerPanel (human) and ChatPanel (AI tools) both drive.
// MapProvider lets panel components (TimeSeries) reach the map instance by id
// ("main") to poll tile-load state without owning any map state.
export default function App() {
  return (
    <MapProvider>
      <div className="app">
        <LayerPanel />
        <div className="mapwrap">
          <MapView />
        </div>
        <ChatPanel />
      </div>
    </MapProvider>
  );
}
