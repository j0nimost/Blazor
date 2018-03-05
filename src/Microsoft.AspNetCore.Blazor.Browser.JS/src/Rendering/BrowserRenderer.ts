﻿import { System_Array, MethodHandle } from '../Platform/Platform';
import { getRenderTreeEditPtr, renderTreeEdit, RenderTreeEditPointer, EditType } from './RenderTreeEdit';
import { getTreeFramePtr, renderTreeFrame, FrameType, RenderTreeFramePointer } from './RenderTreeFrame';
import { platform } from '../Environment';
let raiseEventMethod: MethodHandle;
let renderComponentMethod: MethodHandle;

export class BrowserRenderer {
  private childComponentLocations: { [componentId: number]: Node } = {};

  constructor(private browserRendererId: number) {
  }

  public attachComponentToElement(componentId: number, element: Element) {
    this.insertComponentMarker(componentId, element, 0);
  }

  public updateComponent(componentId: number, edits: System_Array<RenderTreeEditPointer>, editsOffset: number, editsLength: number, referenceFrames: System_Array<RenderTreeFramePointer>) {
    const marker = this.childComponentLocations[componentId];
    if (!marker) {
      throw new Error(`No location is currently associated with component ${componentId}`);
    }

    let parent: Element;
    let childIndex: number;
    let nodeCount: number;
    let isWrapped = false;
    if (marker instanceof Comment) { // TODO: Only if it's the marker for *this* component
      parent = marker.parentElement!;
      childIndex = Array.prototype.indexOf.call(parent.childNodes, marker);
      nodeCount = 0;
      parent.removeChild(marker);
    } else if (marker instanceof Element && marker.tagName === 'BLAZOR-COMPONENT') { // TODO: Only if it's the wrapper for *this* component
      parent = marker;
      childIndex = 0;
      nodeCount = parent.childNodes.length;
      isWrapped = true;
    } else {
      parent = marker.parentElement!;
      childIndex = Array.prototype.indexOf.call(parent.childNodes, marker);
      nodeCount = 1;
    }

    nodeCount += this.applyEdits(componentId, parent, childIndex, edits, editsOffset, editsLength, referenceFrames);

    if (!isWrapped) {
      if (nodeCount === 1) {
        this.childComponentLocations[componentId] = parent.childNodes[childIndex];
      } else {
        const wrapper = document.createElement('blazor-component');
        insertNodeIntoDOM(wrapper, parent, childIndex);
        for (let i = 0; i < nodeCount; i++) {
          wrapper.appendChild(parent.childNodes[childIndex + 1]);
        }
        this.childComponentLocations[componentId] = wrapper;
      }
    }
  }

  public disposeComponent(componentId: number) {
    delete this.childComponentLocations[componentId];
  }

  applyEdits(componentId: number, parent: Element, childIndex: number, edits: System_Array<RenderTreeEditPointer>, editsOffset: number, editsLength: number, referenceFrames: System_Array<RenderTreeFramePointer>): number {
    let currentDepth = 0;
    let childIndexAtCurrentDepth = childIndex;
    let topLevelNodeCountChange = 0;
    const maxEditIndexExcl = editsOffset + editsLength;
    for (let editIndex = editsOffset; editIndex < maxEditIndexExcl; editIndex++) {
      const edit = getRenderTreeEditPtr(edits, editIndex);
      const editType = renderTreeEdit.type(edit);
      switch (editType) {
        case EditType.prependFrame: {
          const frameIndex = renderTreeEdit.newTreeIndex(edit);
          const frame = getTreeFramePtr(referenceFrames, frameIndex);
          const siblingIndex = renderTreeEdit.siblingIndex(edit);
          const numNodesInserted = this.insertFrame(componentId, parent, childIndexAtCurrentDepth + siblingIndex, referenceFrames, frame, frameIndex);
          if (currentDepth === 0) {
            topLevelNodeCountChange += numNodesInserted;
          }
          break;
        }
        case EditType.removeFrame: {
          const siblingIndex = renderTreeEdit.siblingIndex(edit);
          // TODO: Does removing Range frames work correctly?
          removeNodeFromDOM(parent, childIndexAtCurrentDepth + siblingIndex);
          if (currentDepth === 0) {
            topLevelNodeCountChange -= 1;
          }
          break;
        }
        case EditType.setAttribute: {
          const frameIndex = renderTreeEdit.newTreeIndex(edit);
          const frame = getTreeFramePtr(referenceFrames, frameIndex);
          const siblingIndex = renderTreeEdit.siblingIndex(edit);
          const element = parent.childNodes[childIndexAtCurrentDepth + siblingIndex] as HTMLElement;
          this.applyAttribute(componentId, element, frame);
          break;
        }
        case EditType.removeAttribute: {
          const siblingIndex = renderTreeEdit.siblingIndex(edit);
          removeAttributeFromDOM(parent, childIndexAtCurrentDepth + siblingIndex, renderTreeEdit.removedAttributeName(edit)!);
          break;
        }
        case EditType.updateText: {
          const frameIndex = renderTreeEdit.newTreeIndex(edit);
          const frame = getTreeFramePtr(referenceFrames, frameIndex);
          const siblingIndex = renderTreeEdit.siblingIndex(edit);
          const domTextNode = parent.childNodes[childIndexAtCurrentDepth + siblingIndex] as Text;
          domTextNode.textContent = renderTreeFrame.textContent(frame);
          break;
        }
        case EditType.stepIn: {
          const siblingIndex = renderTreeEdit.siblingIndex(edit);
          parent = parent.childNodes[childIndexAtCurrentDepth + siblingIndex] as HTMLElement;
          currentDepth++;
          childIndexAtCurrentDepth = 0;
          break;
        }
        case EditType.stepOut: {
          parent = parent.parentElement!;
          currentDepth--;
          childIndexAtCurrentDepth = currentDepth === 0 ? childIndex : 0; // The childIndex is only ever nonzero at zero depth
          break;
        }
        default: {
          const unknownType: never = editType; // Compile-time verification that the switch was exhaustive
          throw new Error(`Unknown edit type: ${unknownType}`);
        }
      }
    }

    return topLevelNodeCountChange;
  }

  insertFrame(componentId: number, parent: Element, childIndex: number, frames: System_Array<RenderTreeFramePointer>, frame: RenderTreeFramePointer, frameIndex: number): number {
    const frameType = renderTreeFrame.frameType(frame);
    switch (frameType) {
      case FrameType.element:
        this.insertElement(componentId, parent, childIndex, frames, frame, frameIndex);
        return 1;
      case FrameType.text:
        this.insertText(parent, childIndex, frame);
        return 1;
      case FrameType.attribute:
        throw new Error('Attribute frames should only be present as leading children of element frames.');
      case FrameType.component:
        this.insertComponent(parent, childIndex, frame);
        return 1;
      case FrameType.region:
        return this.insertFrameRange(componentId, parent, childIndex, frames, frameIndex + 1, frameIndex + renderTreeFrame.subtreeLength(frame));
      default:
        const unknownType: never = frameType; // Compile-time verification that the switch was exhaustive
        throw new Error(`Unknown frame type: ${unknownType}`);
    }
  }

  insertElement(componentId: number, parent: Element, childIndex: number, frames: System_Array<RenderTreeFramePointer>, frame: RenderTreeFramePointer, frameIndex: number) {
    const tagName = renderTreeFrame.elementName(frame)!;
    const newDomElement = document.createElement(tagName);
    insertNodeIntoDOM(newDomElement, parent, childIndex);

    // Apply attributes
    const descendantsEndIndexExcl = frameIndex + renderTreeFrame.subtreeLength(frame);
    for (let descendantIndex = frameIndex + 1; descendantIndex < descendantsEndIndexExcl; descendantIndex++) {
      const descendantFrame = getTreeFramePtr(frames, descendantIndex);
      if (renderTreeFrame.frameType(descendantFrame) === FrameType.attribute) {
        this.applyAttribute(componentId, newDomElement, descendantFrame);
      } else {
        // As soon as we see a non-attribute child, all the subsequent child frames are
        // not attributes, so bail out and insert the remnants recursively
        this.insertFrameRange(componentId, newDomElement, 0, frames, descendantIndex, descendantsEndIndexExcl);
        break;
      }
    }
  }

  insertComponent(parent: Element, childIndex: number, frame: RenderTreeFramePointer) {
    // All we have to do is associate the child component ID with its location. We don't actually
    // do any rendering here, because the diff for the child will appear later in the render batch.
    const childComponentId = renderTreeFrame.componentId(frame);
    this.insertComponentMarker(childComponentId, parent, childIndex);
  }

  insertComponentMarker(componentId: number, parent: Element, childIndex: number) {
    const marker = document.createComment('blazor-component');
    insertNodeIntoDOM(marker, parent, childIndex);
    this.childComponentLocations[componentId] = marker;
  }

  insertText(parent: Element, childIndex: number, textFrame: RenderTreeFramePointer) {
    const textContent = renderTreeFrame.textContent(textFrame)!;
    const newDomTextNode = document.createTextNode(textContent);
    insertNodeIntoDOM(newDomTextNode, parent, childIndex);
  }

  applyAttribute(componentId: number, toDomElement: Element, attributeFrame: RenderTreeFramePointer) {
    const attributeName = renderTreeFrame.attributeName(attributeFrame)!;
    const browserRendererId = this.browserRendererId;
    const eventHandlerId = renderTreeFrame.attributeEventHandlerId(attributeFrame);

    if (attributeName === 'value') {
      if (this.tryApplyValueProperty(toDomElement, renderTreeFrame.attributeValue(attributeFrame))) {
        return; // If this DOM element type has special 'value' handling, don't also write it as an attribute
      }
    }

    // TODO: Instead of applying separate event listeners to each DOM element, use event delegation
    // and remove all the _blazor*Listener hacks
    switch (attributeName) {
      case 'onclick': {
        toDomElement.removeEventListener('click', toDomElement['_blazorClickListener']);
        const listener = evt => raiseEvent(evt, browserRendererId, componentId, eventHandlerId, 'mouse', { Type: 'click' });
        toDomElement['_blazorClickListener'] = listener;
        toDomElement.addEventListener('click', listener);
        break;
      }
      case 'onchange': {
        toDomElement.removeEventListener('change', toDomElement['_blazorChangeListener']);
        const targetIsCheckbox = isCheckbox(toDomElement);
        const listener = evt => {
          const newValue = targetIsCheckbox ? evt.target.checked : evt.target.value;
          raiseEvent(evt, browserRendererId, componentId, eventHandlerId, 'change', { Type: 'change', Value: newValue });
        };
        toDomElement['_blazorChangeListener'] = listener;
        toDomElement.addEventListener('change', listener);
        break;
      }
      case 'onkeypress': {
        toDomElement.removeEventListener('keypress', toDomElement['_blazorKeypressListener']);
        const listener = evt => {
          // This does not account for special keys nor cross-browser differences. So far it's
          // just to establish that we can pass parameters when raising events.
          // We use C#-style PascalCase on the eventInfo to simplify deserialization, but this could
          // change if we introduced a richer JSON library on the .NET side.
          raiseEvent(evt, browserRendererId, componentId, eventHandlerId, 'keyboard', { Type: evt.type, Key: (evt as any).key });
        };
        toDomElement['_blazorKeypressListener'] = listener;
        toDomElement.addEventListener('keypress', listener);
        break;
      }
      default:
        // Treat as a regular string-valued attribute
        toDomElement.setAttribute(
          attributeName,
          renderTreeFrame.attributeValue(attributeFrame)!
        );
        break;
    }
  }

  tryApplyValueProperty(element: Element, value: string | null) {
    // Certain elements have built-in behaviour for their 'value' property
    switch (element.tagName) {
      case 'INPUT':
      case 'SELECT':
        if (isCheckbox(element)) {
          (element as HTMLInputElement).checked = value === 'True';
        } else {
          // Note: this doen't handle <select> correctly: https://github.com/aspnet/Blazor/issues/157
          (element as any).value = value;
        }
        return true;
      default:
        return false;
    }
  }

  insertFrameRange(componentId: number, parent: Element, childIndex: number, frames: System_Array<RenderTreeFramePointer>, startIndex: number, endIndexExcl: number): number {
    const origChildIndex = childIndex;
    for (let index = startIndex; index < endIndexExcl; index++) {
      const frame = getTreeFramePtr(frames, index);
      const numChildrenInserted = this.insertFrame(componentId, parent, childIndex, frames, frame, index);
      childIndex += numChildrenInserted;

      // Skip over any descendants, since they are already dealt with recursively
      const subtreeLength = renderTreeFrame.subtreeLength(frame);
      if (subtreeLength > 1) {
        index += subtreeLength - 1;
      }
    }

    return (childIndex - origChildIndex); // Total number of children inserted
  }
}

function isCheckbox(element: Element) {
  return element.tagName === 'INPUT' && element.getAttribute('type') === 'checkbox';
}

function insertNodeIntoDOM(node: Node, parent: Element, childIndex: number) {
  if (childIndex >= parent.childNodes.length) {
    parent.appendChild(node);
  } else {
    parent.insertBefore(node, parent.childNodes[childIndex]);
  }
}

function removeNodeFromDOM(parent: Element, childIndex: number) {
  parent.removeChild(parent.childNodes[childIndex]);
}

function removeAttributeFromDOM(parent: Element, childIndex: number, attributeName: string) {
  const element = parent.childNodes[childIndex] as Element;
  element.removeAttribute(attributeName);
}

function raiseEvent(event: Event, browserRendererId: number, componentId: number, eventHandlerId: number, eventInfoType: EventInfoType, eventInfo: any) {
  event.preventDefault();

  if (!raiseEventMethod) {
    raiseEventMethod = platform.findMethod(
      'Microsoft.AspNetCore.Blazor.Browser', 'Microsoft.AspNetCore.Blazor.Browser.Rendering', 'BrowserRendererEventDispatcher', 'DispatchEvent'
    );
  }

  const eventDescriptor = {
    BrowserRendererId: browserRendererId,
    ComponentId: componentId,
    EventHandlerId: eventHandlerId,
    EventArgsType: eventInfoType
  };

  platform.callMethod(raiseEventMethod, null, [
    platform.toDotNetString(JSON.stringify(eventDescriptor)),
    platform.toDotNetString(JSON.stringify(eventInfo))
  ]);
}

type EventInfoType = 'mouse' | 'keyboard' | 'change';
