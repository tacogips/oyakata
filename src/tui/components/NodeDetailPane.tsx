import type { OpenTuiMainViewRefs } from "../opentui-solid-components";
import { Box, FocusSelect, ScrollBox, Text } from "../opentui-solid-components";

export interface NodeDetailPaneProps {
  readonly refs: OpenTuiMainViewRefs;
}

export function NodeDetailPane(props: NodeDetailPaneProps) {
  return (
    <ScrollBox
      ref={(node) => {
        props.refs.detailScroll = node;
      }}
      id="detail-scroll"
      width="100%"
      minWidth={0}
      flexGrow={30}
      border
      title=" node detail "
      borderColor="#5b6670"
      scrollY
      focusable
    >
      <Box
        id="detail-scroll-column"
        flexDirection="column"
        flexGrow={1}
        width="100%"
      >
        <Text
          ref={(node) => {
            props.refs.detailSummaryHeader = node;
          }}
          id="detail-summary-header"
          width="100%"
          content=""
        />
        <FocusSelect
          ref={(node) => {
            props.refs.detailSummarySelect = node;
          }}
          id="detail-summary-select"
          showDescription
          flexGrow={1}
          width="100%"
          height="100%"
          itemSpacing={2}
          selectedBackgroundColor="#1f3447"
          selectedTextColor="#f7d774"
          descriptionColor="#89a5ba"
          selectedDescriptionColor="#d8e5f2"
        />
        <Text
          ref={(node) => {
            props.refs.detailText = node;
          }}
          id="detail-text"
          flexGrow={1}
          width="100%"
          content=""
        />
      </Box>
    </ScrollBox>
  );
}
