param(
  [Parameter(Mandatory = $true)]
  [string]$RequestPath
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$msoTrue = -1
$msoFalse = 0
$msoGroup = 6
$msoTextOrientationHorizontal = 1

function Get-PropertyValue {
  param($Object, [string]$Name, $Fallback)
  try {
    $value = $Object.$Name
    if ($null -eq $value) { return $Fallback }
    return $value
  } catch {
    return $Fallback
  }
}

function ConvertFrom-OfficeRgb {
  param($Value, [string]$Fallback = "000000")
  try {
    $number = [int64]$Value
    if ($number -lt 0) { return $Fallback }
    $r = $number -band 0xff
    $g = ($number -shr 8) -band 0xff
    $b = ($number -shr 16) -band 0xff
    return "{0:X2}{1:X2}{2:X2}" -f $r, $g, $b
  } catch {
    return $Fallback
  }
}

function ConvertTo-OfficeRgb {
  param([string]$Hex)
  $clean = ($Hex -replace "#", "").Trim()
  if ($clean.Length -eq 3) {
    $clean = "{0}{0}{1}{1}{2}{2}" -f $clean[0], $clean[1], $clean[2]
  }
  if ($clean -notmatch "^[0-9a-fA-F]{6}$") { throw "Invalid color: $Hex" }
  $r = [Convert]::ToInt32($clean.Substring(0, 2), 16)
  $g = [Convert]::ToInt32($clean.Substring(2, 2), 16)
  $b = [Convert]::ToInt32($clean.Substring(4, 2), 16)
  return $r + ($g * 256) + ($b * 65536)
}

function Add-ShapeRecords {
  param($Shapes, [int]$SlideIndex, $Records)
  for ($i = 1; $i -le $Shapes.Count; $i++) {
    $shape = $Shapes.Item($i)
    try {
      if ([int](Get-PropertyValue $shape "Type" 0) -eq $msoGroup) {
        Add-ShapeRecords $shape.GroupItems $SlideIndex $Records
      }

      $hasTextFrame = [int](Get-PropertyValue $shape "HasTextFrame" 0) -eq $msoTrue
      $hasText = $false
      if ($hasTextFrame) {
        $hasText = [int](Get-PropertyValue $shape.TextFrame "HasText" 0) -eq $msoTrue
      }
      if (-not $hasText) { continue }

      $range = $shape.TextFrame.TextRange
      $font = $range.Font
      $paragraph = $range.ParagraphFormat
      $Records.Add([pscustomobject]@{
        id = [int]$shape.Id
        slideIndex = $SlideIndex
        name = [string](Get-PropertyValue $shape "Name" "Text box")
        text = ([string](Get-PropertyValue $range "Text" "")).Replace("`r", "`n")
        x = [double](Get-PropertyValue $shape "Left" 0)
        y = [double](Get-PropertyValue $shape "Top" 0)
        width = [double](Get-PropertyValue $shape "Width" 100)
        height = [double](Get-PropertyValue $shape "Height" 40)
        rotation = [double](Get-PropertyValue $shape "Rotation" 0)
        zOrder = [int](Get-PropertyValue $shape "ZOrderPosition" 0)
        fontName = [string](Get-PropertyValue $font "Name" "Arial")
        fontSize = [double](Get-PropertyValue $font "Size" 18)
        color = ConvertFrom-OfficeRgb (Get-PropertyValue $font.Color "RGB" 0)
        bold = [int](Get-PropertyValue $font "Bold" 0) -eq $msoTrue
        italic = [int](Get-PropertyValue $font "Italic" 0) -eq $msoTrue
        underline = [int](Get-PropertyValue $font "Underline" 0) -eq $msoTrue
        alignment = [int](Get-PropertyValue $paragraph "Alignment" 1)
        marginLeft = [double](Get-PropertyValue $shape.TextFrame "MarginLeft" 0)
        marginRight = [double](Get-PropertyValue $shape.TextFrame "MarginRight" 0)
        marginTop = [double](Get-PropertyValue $shape.TextFrame "MarginTop" 0)
        marginBottom = [double](Get-PropertyValue $shape.TextFrame "MarginBottom" 0)
      }) | Out-Null
    } finally {
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shape)
    }
  }
}

function Find-ShapeById {
  param($Shapes, [int]$ShapeId)
  for ($i = 1; $i -le $Shapes.Count; $i++) {
    $shape = $Shapes.Item($i)
    if ([int]$shape.Id -eq $ShapeId) { return $shape }
    if ([int](Get-PropertyValue $shape "Type" 0) -eq $msoGroup) {
      $found = Find-ShapeById $shape.GroupItems $ShapeId
      if ($null -ne $found) {
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shape)
        return $found
      }
    }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shape)
  }
  return $null
}

function Set-TextShapeFormat {
  param($Shape, $Operation)
  if ([int](Get-PropertyValue $Shape "HasTextFrame" 0) -ne $msoTrue) { throw "The selected shape is not a text box" }
  $range = $Shape.TextFrame.TextRange
  $propertyNames = @($Operation.PSObject.Properties.Name)
  if ($propertyNames -contains "text") { $range.Text = ([string]$Operation.text).Replace("`n", "`r") }
  if ($propertyNames -contains "fontName") { $range.Font.Name = [string]$Operation.fontName }
  if ($propertyNames -contains "fontSize") { $range.Font.Size = [double]$Operation.fontSize }
  if ($propertyNames -contains "color") { $range.Font.Color.RGB = ConvertTo-OfficeRgb ([string]$Operation.color) }
  if ($propertyNames -contains "bold") { $range.Font.Bold = $(if ([bool]$Operation.bold) { $msoTrue } else { $msoFalse }) }
  if ($propertyNames -contains "italic") { $range.Font.Italic = $(if ([bool]$Operation.italic) { $msoTrue } else { $msoFalse }) }
  if ($propertyNames -contains "underline") { $range.Font.Underline = $(if ([bool]$Operation.underline) { $msoTrue } else { $msoFalse }) }
  if ($propertyNames -contains "alignment") { $range.ParagraphFormat.Alignment = [int]$Operation.alignment }
  if ($propertyNames -contains "x") { $Shape.Left = [double]$Operation.x }
  if ($propertyNames -contains "y") { $Shape.Top = [double]$Operation.y }
  if ($propertyNames -contains "width") { $Shape.Width = [double]$Operation.width }
  if ($propertyNames -contains "height") { $Shape.Height = [double]$Operation.height }
}

$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$powerPoint = $null
$presentation = $null
$temporaryImages = [System.Collections.Generic.List[string]]::new()

try {
  $powerPoint = New-Object -ComObject PowerPoint.Application
  $powerPoint.DisplayAlerts = 1
  $readOnly = $request.mode -eq "model"
  $presentation = $powerPoint.Presentations.Open([string]$request.inputPath, $readOnly, $msoFalse, $msoFalse)

  if ($request.mode -eq "model") {
    $slideItems = [System.Collections.Generic.List[object]]::new()
    for ($slideIndex = 1; $slideIndex -le $presentation.Slides.Count; $slideIndex++) {
      $slide = $presentation.Slides.Item($slideIndex)
      try {
        $records = [System.Collections.Generic.List[object]]::new()
        Add-ShapeRecords $slide.Shapes $slideIndex $records
        $followMaster = [int](Get-PropertyValue $slide "FollowMasterBackground" $msoTrue) -eq $msoTrue
        $background = "FFFFFF"
        if (-not $followMaster) {
          $background = ConvertFrom-OfficeRgb (Get-PropertyValue $slide.Background.Fill.ForeColor "RGB" 16777215) "FFFFFF"
        }
        $slideItems.Add([pscustomobject]@{
          index = $slideIndex
          backgroundColor = $background
          followMasterBackground = $followMaster
          shapes = @($records)
        }) | Out-Null
      } finally {
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($slide)
      }
    }
    [pscustomobject]@{
      slideWidth = [double]$presentation.PageSetup.SlideWidth
      slideHeight = [double]$presentation.PageSetup.SlideHeight
      slides = @($slideItems)
    } | ConvertTo-Json -Compress -Depth 20
    exit 0
  }

  if ($request.mode -ne "edit") { throw "Unknown PowerPoint editor mode: $($request.mode)" }
  foreach ($operation in @($request.operations)) {
    $slideIndex = [int]$operation.slideIndex
    if ($slideIndex -lt 1 -or $slideIndex -gt $presentation.Slides.Count) { throw "Slide index out of range: $slideIndex" }
    $slide = $presentation.Slides.Item($slideIndex)
    try {
      switch ([string]$operation.kind) {
        "updateText" {
          $shape = Find-ShapeById $slide.Shapes ([int]$operation.shapeId)
          if ($null -eq $shape) { throw "Text shape not found: $($operation.shapeId)" }
          try { Set-TextShapeFormat $shape $operation } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shape) }
        }
        "addText" {
          $shape = $slide.Shapes.AddTextbox($msoTextOrientationHorizontal, [double]$operation.x, [double]$operation.y, [double]$operation.width, [double]$operation.height)
          try {
            $shape.Line.Visible = $msoFalse
            $shape.Fill.Visible = $msoFalse
            Set-TextShapeFormat $shape $operation
          } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shape) }
        }
        "addImage" {
          $extension = ([string]$operation.extension -replace "[^a-zA-Z0-9]", "").ToLowerInvariant()
          if (-not $extension) { $extension = "png" }
          $imagePath = Join-Path ([IO.Path]::GetTempPath()) ("ade-ppt-image-{0}.{1}" -f [guid]::NewGuid(), $extension)
          [IO.File]::WriteAllBytes($imagePath, [Convert]::FromBase64String([string]$operation.dataBase64))
          $temporaryImages.Add($imagePath) | Out-Null
          $shape = $slide.Shapes.AddPicture($imagePath, $msoFalse, $msoTrue, [double]$operation.x, [double]$operation.y, [double]$operation.width, [double]$operation.height)
          [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shape)
        }
        "deleteShape" {
          $shape = Find-ShapeById $slide.Shapes ([int]$operation.shapeId)
          if ($null -ne $shape) {
            try { $shape.Delete() } finally { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shape) }
          }
        }
        "setBackground" {
          $slide.FollowMasterBackground = $msoFalse
          $slide.Background.Fill.Solid()
          $slide.Background.Fill.ForeColor.RGB = ConvertTo-OfficeRgb ([string]$operation.color)
        }
        default { throw "Unknown PowerPoint edit operation: $($operation.kind)" }
      }
    } finally {
      [void][Runtime.InteropServices.Marshal]::ReleaseComObject($slide)
    }
  }
  $presentation.Save()
  [pscustomobject]@{ ok = $true; operationCount = @($request.operations).Count } | ConvertTo-Json -Compress
} finally {
  foreach ($path in $temporaryImages) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
  if ($null -ne $presentation) {
    try { $presentation.Close() } catch {}
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation)
  }
  if ($null -ne $powerPoint) {
    try { $powerPoint.Quit() } catch {}
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
