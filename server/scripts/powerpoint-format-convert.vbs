' Convert legacy .ppt presentations to OOXML .pptx using PowerPoint COM.
' Args: input path, output path, target format code (24 = ppSaveAsOpenXMLPresentation).
Function StripQuotes(value)
  If Left(value, 1) = """" And Right(value, 1) = """" Then
    StripQuotes = Mid(value, 2, Len(value) - 2)
  Else
    StripQuotes = value
  End If
End Function

inputFile = StripQuotes(WScript.Arguments(0))
outputFile = StripQuotes(WScript.Arguments(1))
formatCode = CLng(StripQuotes(WScript.Arguments(2)))

On Error Resume Next
Set objPowerPoint = CreateObject("PowerPoint.Application")
If Err.Number <> 0 Then
  WScript.Echo "ERROR_CREATE_POWERPOINT: " & Err.Description
  WScript.Quit 2
End If

' ReadOnly=True, Untitled=False, WithWindow=False keeps conversion off-screen.
Set objPresentation = objPowerPoint.Presentations.Open(inputFile, True, False, False)
If Err.Number <> 0 Then
  objPowerPoint.Quit
  WScript.Echo "ERROR_OPEN: " & Err.Description & " [" & inputFile & "]"
  WScript.Quit 3
End If

objPresentation.SaveAs outputFile, formatCode
If Err.Number <> 0 Then
  objPresentation.Close
  objPowerPoint.Quit
  WScript.Echo "ERROR_SAVE: " & Err.Description & " [" & outputFile & "]"
  WScript.Quit 4
End If

objPresentation.Close
objPowerPoint.Quit
WScript.Echo "OK"
