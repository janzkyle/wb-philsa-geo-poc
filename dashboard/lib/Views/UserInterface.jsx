import PropTypes from "prop-types";
import React, { useState } from "react";
import RelatedMaps from "terriajs/lib/ReactViews/RelatedMaps/RelatedMaps";
import { MenuLeft } from "terriajs/lib/ReactViews/StandardUserInterface/customizable/Groups";
import MenuItem from "terriajs/lib/ReactViews/StandardUserInterface/customizable/MenuItem";
import StandardUserInterface from "terriajs/lib/ReactViews/StandardUserInterface/StandardUserInterface";
import version from "../../version";
import GenAIAssistant from "./GenAIAssistant/GenAIAssistant";

const PHILSA_BLUE = "#1d5285";

// Floating action button that toggles the GenAI assistant panel.
const AssistantToggle = ({ open, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    title={open ? "Close dashboard assistant" : "Ask the dashboard assistant"}
    aria-label="Toggle dashboard assistant"
    style={{
      position: "fixed",
      // Lifted above Terria's bottom bar (map credits + "Give feedback") so it
      // doesn't cover the bar's right side.
      bottom: 120,
      right: 16,
      zIndex: 1001,
      height: 48,
      padding: "0 18px",
      borderRadius: 24,
      border: "none",
      background: PHILSA_BLUE,
      color: "#fff",
      fontWeight: 700,
      fontSize: 14,
      fontFamily: "'Segoe UI', Roboto, Helvetica, sans-serif",
      boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
      cursor: "pointer"
    }}
  >
    {open ? "Close" : "✦ Ask AI"}
  </button>
);

AssistantToggle.propTypes = {
  open: PropTypes.bool,
  onClick: PropTypes.func
};

export const TerriaUserInterface = ({ terria, viewState, themeOverrides }) => {
  const relatedMaps = viewState.terria.configParameters.relatedMaps;
  const aboutButtonHrefUrl =
    viewState.terria.configParameters.aboutButtonHrefUrl;

  const [assistantOpen, setAssistantOpen] = useState(false);

  return (
    <>
      <StandardUserInterface
        terria={terria}
        viewState={viewState}
        themeOverrides={themeOverrides}
        version={version}
      >
        <MenuLeft>
          {aboutButtonHrefUrl ? (
            <MenuItem
              caption="About"
              href={aboutButtonHrefUrl}
              key="about-link"
            />
          ) : null}
          {relatedMaps && relatedMaps.length > 0 ? (
            <RelatedMaps relatedMaps={relatedMaps} />
          ) : null}
        </MenuLeft>
      </StandardUserInterface>

      <AssistantToggle
        open={assistantOpen}
        onClick={() => setAssistantOpen((v) => !v)}
      />
      <GenAIAssistant
        terria={terria}
        isOpen={assistantOpen}
        onClose={() => setAssistantOpen(false)}
      />
    </>
  );
};

TerriaUserInterface.propTypes = {
  terria: PropTypes.object.isRequired,
  viewState: PropTypes.object.isRequired,
  themeOverrides: PropTypes.object
};
