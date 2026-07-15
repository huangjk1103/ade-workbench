' Render every source slide through PowerPoint itself and place the resulting
' high-resolution PNG on a same-size blank slide. This preserves the exact
' static appearance (fonts, Office shapes, EMF/WMF/TIFF, charts and effects)
' while producing an OOXML file the browser viewer can display reliably.
Function StripQuotes(value)
  If Left(value, 1) = """" And Right(value, 1) = """" Then
    StripQuotes = Mid(value, 2, Len(value) - 2)
  Else
    StripQuotes = value
  End If
End Function

Function ReadShapeText(shape)
  On Error Resume Next
  Dim result, i, row, col
  result = ""
  If shape.Type = 6 Then
    For i = 1 To shape.GroupItems.Count
      result = result & " " & ReadShapeText(shape.GroupItems.Item(i))
    Next
  End If
  If shape.HasTextFrame Then
    If shape.TextFrame.HasText Then result = result & " " & shape.TextFrame.TextRange.Text
  End If
  If shape.HasTable Then
    For row = 1 To shape.Table.Rows.Count
      For col = 1 To shape.Table.Columns.Count
        result = result & " " & shape.Table.Cell(row, col).Shape.TextFrame.TextRange.Text
      Next
    Next
  End If
  Err.Clear
  ReadShapeText = result
End Function

Function ReadSlideText(slide)
  Dim result, shape
  result = ""
  For Each shape In slide.Shapes
    result = result & " " & ReadShapeText(shape)
  Next
  ReadSlideText = Trim(result)
End Function

inputFile = StripQuotes(WScript.Arguments(0))
outputFile = StripQuotes(WScript.Arguments(1))

On Error Resume Next
Set fso = CreateObject("Scripting.FileSystemObject")
tempFolder = fso.BuildPath(fso.GetSpecialFolder(2), "ade-ppt-preview-" & fso.GetTempName)
fso.CreateFolder tempFolder

Set app = CreateObject("PowerPoint.Application")
If Err.Number <> 0 Then
  WScript.Echo "ERROR_CREATE_POWERPOINT: " & Err.Description
  WScript.Quit 2
End If

Set source = app.Presentations.Open(inputFile, True, False, False)
If Err.Number <> 0 Then
  app.Quit
  WScript.Echo "ERROR_OPEN: " & Err.Description & " [" & inputFile & "]"
  WScript.Quit 3
End If

Set preview = app.Presentations.Add(False)
Do While preview.Slides.Count > 0
  preview.Slides(1).Delete
Loop
preview.PageSetup.SlideWidth = source.PageSetup.SlideWidth
preview.PageSetup.SlideHeight = source.PageSetup.SlideHeight
slideWidth = source.PageSetup.SlideWidth
slideHeight = source.PageSetup.SlideHeight
pixelWidth = 1920
pixelHeight = CLng(pixelWidth * slideHeight / slideWidth)

For index = 1 To source.Slides.Count
  Err.Clear
  pngPath = fso.BuildPath(tempFolder, "slide-" & CStr(index) & ".png")
  source.Slides(index).Export pngPath, "PNG", pixelWidth, pixelHeight
  If Err.Number <> 0 Then
    source.Close
    preview.Close
    app.Quit
    WScript.Echo "ERROR_EXPORT_SLIDE_" & CStr(index) & ": " & Err.Description
    WScript.Quit 4
  End If

  Set targetSlide = preview.Slides.Add(index, 12) ' ppLayoutBlank
  targetSlide.Shapes.AddPicture pngPath, False, True, 0, 0, slideWidth, slideHeight

  ' Retain searchable slide text outside the visible canvas. The browser
  ' clips this shape, but pptx-preview still exposes its textContent.
  slideText = ReadSlideText(source.Slides(index))
  If Len(slideText) > 0 Then
    Set textShape = targetSlide.Shapes.AddTextbox(1, -10000, -10000, 1, 1)
    textShape.TextFrame.TextRange.Text = slideText
  End If
Next

preview.SaveAs outputFile, 24 ' ppSaveAsOpenXMLPresentation
If Err.Number <> 0 Then
  source.Close
  preview.Close
  app.Quit
  WScript.Echo "ERROR_SAVE: " & Err.Description & " [" & outputFile & "]"
  WScript.Quit 5
End If

source.Close
preview.Close
app.Quit
On Error Resume Next
fso.DeleteFolder tempFolder, True
WScript.Echo "OK"
